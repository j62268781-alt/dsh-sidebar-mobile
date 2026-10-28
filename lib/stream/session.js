/**
 * 流会话：一条设备流，多个消费者，空闲自停。
 *
 * ── 为什么由 Host 持有子进程而不是让每个消费者各起一个 ────────────────
 * mobilecli 的 `screencapture` 是一个持续输出的子进程，启动它要经过
 * 「找设备 → 拉起 on-device agent → 开始编码」，实测首次出帧约 200ms，
 * 而 iOS 上还要等 agent 就绪（可能几秒）。面板刷新、截图卡片、模型工具
 * 三处都可能同时想要画面，各起一个进程会：
 *   - 让设备端反复经历 agent 启停
 *   - 在 USB 真机上争抢带宽（实测多流会显著降低各自帧率）
 * 所以这里做**单流多播**：一个设备一条流，消费者订阅同一份字节。
 *
 * ── 为什么用 CLI 而不是 mobilecli server 的 sessionUrl ────────────────
 * server 模式要多管一个常驻 HTTP 服务（端口占用、会话过期、二次清理），
 * 而 `screencapture` 写 stdout 的路径已经被实测验证（Android 104fps /
 * iOS 模拟器 131fps）。少一层进程就少一类失败。
 *
 * ── 空闲自停 ──────────────────────────────────────────────────────────
 * 面板关掉后不该让设备一直编码（耗电、占 USB 带宽）。消费者归零后起一个
 * 计时器，超时停流；下一次订阅会重新拉起。**主动停止从不被重启逻辑对抗**：
 * stop 会先摘掉自动重启的意图，否则退出事件会把刚停掉的流又拉起来。
 *
 * @module dsh-sidebar-mobile/lib/stream-session
 */

/**
 * swipe 的默认时长（毫秒）。
 *
 * mobilecli 不传 `--duration` 时用"平台默认"，实测就是 1000ms ——
 * 面板上会明显感到滑动慢半拍。300ms 接近真实 fling 手感。
 */
export const DEFAULT_SWIPE_DURATION_MS = 300;

/**
 * 缩放差异多大才值得为它**重启编码器**（相对值，1.01 = 1%）。
 *
 * 重启不是免费的：编码器重新起流程要一段黑场，实测 IDR 间隔约 0.54 秒，
 * 所以阈值不能无限小 —— 但**也不能大到把"轻微放大"放过去**。
 *
 * 这里原来是 1.15，理由是"宽 3% 宁可按旧流继续"。真机上这条推理破了产：
 * 面板画布 596 物理像素、流 540 宽（差 10%，落在 1.15 的死区里），请求
 * 更高分位时既不重建也不生效，浏览器把每帧放大 1.10× 铺上去 —— 用户看到的
 * 就是"文字有点糊"。**只要帧比画布小，插值就在发生**，而欠 10% 和欠 40%
 * 在"糊"这件事上没有本质区别，只是程度不同。
 *
 * 所以判据改成"新 scale 明显更大（>1%）就重建"，抖动靠三道闸门兜：
 * 客户端 600ms 持续判定 + 5 秒冷却，以及这里的 3 秒节流
 * （scaleRestartIntervalMs）。1.01 而不是 1.0，是为了吸收 scale 量化
 * （Host 截到 3 位小数）与编码器宏块对齐带来的 1-2px 回差。
 */
export const SCALE_RESTART_RATIO = 1.01;

/**
 * 缩放差异多大才值得为它**降级**重建（相对值，1.5 = 当前编码宽是需要的 1.5 倍）。
 *
 * 升级与降级不对称，是成本不对称：升级不重建的代价是每一帧都在浏览器里被放大
 * 插值（画面持续糊，用户看得见）；降级不重建的代价只是"多解了像素"（浪费 GPU/CPU，
 * 画质不降）。所以降级阈值要**远**大于 1%（1.01），否则拖窗口时宽度来回抖几像素
 * 就会反复杀编码器，每次都黑一段。
 *
 * 1.5 这个数是从实测的阶梯档位反推的：阶梯取流只在 0.5 与 1.0 两档间跳
 * （面板拖窄 1.0 → 0.5），那是 2 倍差、解码量降到 1/4（1080×2376 → 540×1188），
 * 锐度与原生持平（Sobel 边缘 0.972 vs 0.973），完全值回一次 IDR 黑场。
 * 中间那类"只小一点"的变化（比如 1.0 → 0.9，1.11 倍）白解码的像素不到两成，
 * 收益抵不过闪一下，落在阈值下侧。
 */
export const SCALE_DOWNGRADE_RATIO = 1.5;

/** 从首块字节嗅探流格式，而不是相信我们请求了什么。 */
export function sniffStreamFormat(head) {
  if (!Buffer.isBuffer(head) || head.length === 0) {
    return { kind: "unknown" };
  }

  // H.264 Annex B：起始码 00 00 00 01 或 00 00 01
  if (
    (head.length >= 4 && head[0] === 0 && head[1] === 0 && head[2] === 0 && head[3] === 1) ||
    (head.length >= 3 && head[0] === 0 && head[1] === 0 && head[2] === 1)
  ) {
    return { kind: "h264", contentType: "video/h264" };
  }

  // MJPEG 多部分：以 --<boundary> 开头
  if (head[0] === 0x2d && head[1] === 0x2d) {
    const lineEnd = head.indexOf("\r\n");
    const boundary = lineEnd === -1 ? head.toString("latin1") : head.subarray(0, lineEnd).toString("latin1");
    return {
      kind: "mjpeg",
      boundary,
      contentType: `multipart/x-mixed-replace; boundary=${boundary.replace(/^--/, "")}`,
    };
  }

  return { kind: "unknown" };
}

/**
 * 一条设备流的生命周期。
 *
 * 状态机：idle → running → (crash → 自动重启) → stopped
 * stopped 是终态，只有 dispose()/stop() 会进入。
 */
export class StreamSession {
  /**
   * @param {object} options
   * @param {string} options.deviceId
   * @param {() => {child: any, stdout: NodeJS.ReadableStream, stderr: () => string, kill: () => void}} options.spawn
   *   实际的进程启动器，由调用方注入（便于测试替身）
   * @param {number} [options.idleStopMs] 消费者归零后多久停流
   * @param {number} [options.restartDelayMs] 崩溃后重启延迟
   * @param {number} [options.scale] 编码缩放（1 = 原分辨率），见下面字段说明
   * @param {Function} [options.log]
   */
  constructor({ deviceId, spawn, scale = 1, idleStopMs = 300_000, restartDelayMs = 5_000, log = () => {} }) {
    this.deviceId = deviceId;
    this.spawnFn = spawn;
    /**
     * 这条流的编码缩放。
     *
     * 真正用途只有一个：#control 把客户端报的**帧像素**坐标换回**设备像素**。
     * 必须用流的真实缩放，而不是"这次请求希望的值" —— 会话已经在跑时新值延后
     * 生效（见 StreamSessionPool.acquire），两者会不一致，按后者换算点击就会偏。
     */
    this.scale = typeof scale === "number" && scale > 0 ? scale : 1;
    this.idleStopMs = idleStopMs;
    this.restartDelayMs = restartDelayMs;
    this.log = log;

    /** @type {Set<(chunk: Buffer) => void>} */
    this.consumers = new Set();
    /**
     * 会话被主动终结时要通知的回调（每个订阅者最多一个）。
     *
     * 与 consumers 分开存：consumers 是"有字节时喂进去"，这里只在 stop() 时触发，
     * 用来结束挂在流上的 HTTP 响应（详见 stop() 的说明）。
     *
     * @type {Set<() => void>}
     */
    this.stopListeners = new Set();
    /** @type {{child: any, stdout: NodeJS.ReadableStream, stderr: () => string, kill: () => void}|null} */
    this.proc = null;
    /** 首块字节缓存：消费者可能在流已开始后才订阅，需要把格式信息补给它。 */
    this.head = null;
    this.format = { kind: "unknown" };
    this.idleTimer = null;
    this.restartTimer = null;
    /** 主动停止的意图。置位后退出事件不再触发重启。 */
    this.stopping = false;
    this.stopped = false;
    /** 崩溃计数，用于日志与退避（不无限快速重启）。 */
    this.crashCount = 0;
  }

  /** 当前是否有活着的流进程。 */
  get running() {
    return this.proc !== null;
  }

  /**
   * 订阅流。首个消费者会拉起进程；后续消费者复用。
   *
   * @param {(chunk: Buffer) => void} onChunk
   * @param {(() => void)|null} [onStop]
   *   会话被**主动终结**（按新缩放重建、切设备、卸载）时回调。
   *   为什么需要它：终结时消费者会被清空，HTTP 响应从此再也收不到字节，
   *   不主动 `res.end()` 的话浏览器只能等自己的看门狗超时才发现流死了 ——
   *   这段时间画面完全冻住。由会话通知，响应才能立刻结束、客户端立刻重连。
   * @returns {{remove: () => void, format: () => object, head: () => Buffer|null}}
   */
  addConsumer(onChunk, onStop = null) {
    if (this.stopped) {
      throw new Error(`stream session for ${this.deviceId} is stopped`);
    }

    this.consumers.add(onChunk);
    if (typeof onStop === "function") this.stopListeners.add(onStop);
    this.#cancelIdleStop();

    // 已经有流时，把首块与格式立刻回放给新消费者：它可能错过了之前的分片。
    if (this.running && this.head !== null) {
      try {
        onChunk(this.head);
      } catch (error) {
        this.log("error", `回放首帧失败：${error?.message ?? error}`);
      }
    }

    if (!this.running) this.#start();

    let removed = false;
    return {
      remove: () => {
        if (removed) return;
        removed = true;
        this.consumers.delete(onChunk);
        if (typeof onStop === "function") this.stopListeners.delete(onStop);
        // 已经停产了就别再排空闲自停（那只会留一个 300 秒后空转的定时器）
        if (this.stopped) return;
        if (this.consumers.size === 0) this.#scheduleIdleStop();
      },
      format: () => this.format,
      head: () => this.head,
    };
  }

  /**
   * 停止并进入终态。用于插件卸载、切换设备、**按新缩放重建流**。
   *
   * 终结时必须通知挂在流上的那些 HTTP 响应（见 stopListeners）：它们不会再有
   * 任何字节可写，主动结束才能让客户端马上重连到新会话 —— 否则浏览器要等
   * 自己的看门狗（客户端实测 5 秒起）才动，这段时间画面是冻住的。
   */
  stop() {
    this.stopping = true;
    this.stopped = true;
    this.#cancelIdleStop();
    this.#cancelRestart();
    this.#killProc();
    this.consumers.clear();

    const listeners = [...this.stopListeners];
    this.stopListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.log("warn", `结束流响应失败：${error?.message ?? error}`);
      }
    }
  }

  /**
   * 把一次点击/滑动转发到设备。
   *
   * 这里只做参数校验与命令拼装，实际执行交给调用方注入的 runCommand，
   * 因为"命令怎么跑"是客户端模块的职责，会话只管流。
   *
   * @param {(args: string[]) => Promise<unknown>} runCommand
   * @param {{action: string, x?: number, y?: number, x1?: number, y1?: number, x2?: number, y2?: number, text?: string, name?: string, duration?: number}} input
   * @returns {Promise<unknown>}
   */
  async sendInput(runCommand, input) {
    const base = ["--device", this.deviceId];
    switch (input.action) {
      case "tap":
        return runCommand(["io", "tap", ...base, `${input.x},${input.y}`]);
      case "longpress":
        return runCommand([
          "io", "longpress", ...base, `${input.x},${input.y}`,
          ...(input.duration === undefined ? [] : ["--duration", String(input.duration)]),
        ]);
      case "swipe":
        /**
         * ⚠️ `--duration` **必须传**。
         *
         * mobilecli 的 help 原文：`duration of the swipe in milliseconds
         * (0 uses the platform default)`。实测那"平台默认"就是 **1000ms**：
         *
         *     mobilecli io swipe --device X 540,1800,540,700               → 1074ms
         *     mobilecli io swipe --device X 540,1800,540,700 --duration 300 →  374ms
         *     mobilecli io swipe --device X 540,1800,540,700 --duration 100 →  175ms
         *
         * 面板上手指一拖就发一次 swipe，每次都在设备端"慢动作"跑满 1 秒，
         * 后续手势只能排队 —— 这正是"滑动感觉很慢"的直接原因。
         *
         * 300ms 接近 Android 上真实的快速滑动（fling）手感：既跟得上手指，
         * 又不会快到被系统当成点击。
         */
        return runCommand([
          "io", "swipe", ...base,
          `${input.x1},${input.y1},${input.x2},${input.y2}`,
          "--duration", String(input.duration ?? DEFAULT_SWIPE_DURATION_MS),
        ]);
      case "text":
        return runCommand(["io", "text", ...base, String(input.text ?? "")]);
      case "keys":
        /**
         * 键盘按键（物理键盘透传）。支持组合键，也支持一次发多个。
         *
         * ⚠️ **一次调用必须尽量多带几个键**。每条 mobilecli 命令实测约
         * 100ms（62ms 进程启动 + 41ms daemon/adb 往返），逐字符发的话
         * 打字就没法用了。`io keys` 本身接受多个 key-combo 参数，所以
         * 由调用方（面板）负责把连续按键合并成一批。
         *
         * 键名实测（一加 12 / Android 16 全接受，0 拒绝）：
         *   backspace delete forwarddelete enter tab escape
         *   up down left right home end space pageup pagedown
         *   字母/数字、以及 shift+a / ctrl+a / cmd+a / alt+tab / ctrl+shift+z
         */
        return runCommand(["io", "keys", ...base, ...input.keys]);
      case "button":
        return runCommand(["io", "button", ...base, String(input.name ?? "HOME")]);
      default:
        throw new Error(`不支持的操作：${input.action}`);
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  #start() {
    if (this.stopped || this.running) return;

    let proc;
    try {
      proc = this.spawnFn();
    } catch (error) {
      this.log("error", `启动流失败：${error?.message ?? error}`);
      this.#scheduleRestart();
      return;
    }
    this.proc = proc;

    proc.stdout?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.head === null) {
        this.head = buf;
        this.format = sniffStreamFormat(buf);
        this.log("info", `流已就绪：${this.deviceId} / ${this.format.kind}`);
        /**
         * ⚠️ 拿到第一块数据就认为"这次启动成功了"，把退避计数清零。
         *
         * 不清零的话，crashCount 只会在**空闲自停**时归零（见 #armIdleStop），
         * 于是它会**单向累积**：一次网络抖动 + 一次设备忙碌，就能把退避
         * 推到 30s 上限，而此后即使流一直跑得很好，下次崩溃也要干等 30s。
         * 表现是"卡了一下之后再也回不来"，且越用越糟。
         *
         * 用"首块到达"而不是"进程还活着"作为成功信号：进程起来但立刻退出的
         * 情况（本文件里就有——设备端 agent 没起来时只输出 `Error:`）不该
         * 算成功，否则会退化成无退避的快速重启循环。
         */
        this.crashCount = 0;
      }
      for (const consumer of this.consumers) {
        try {
          consumer(buf);
        } catch (error) {
          // 单个消费者写失败（通常是客户端断开）不应影响其他人
          this.log("error", `消费者写入失败：${error?.message ?? error}`);
        }
      }
    });

    proc.stdout?.on("error", (error) => {
      this.log("error", `流 stdout 出错：${error?.message ?? error}`);
    });

    proc.child?.on?.("exit", (code, signal) => {
      if (!this.#resetProc(proc)) return;

      this.crashCount += 1;
      const detail = proc.stderr?.() ?? "";
      this.log(
        "warn",
        `流进程退出（code=${code} signal=${signal}）${detail === "" ? "" : `：${detail.slice(0, 200)}`}`,
      );
      // 还有人订阅才重启；没人订阅就等下次 addConsumer
      if (this.consumers.size > 0) this.#scheduleRestart();
    });

    /**
     * ⚠️ spawn 失败**只发 'error'，不发 'exit'**。
     *
     * ENOENT（mobilecli 被删了 / PATH 变了）、EACCES、EMFILE 都是这条路径。
     * 之前这里只监听 'exit'，于是 spawn 失败时会话永远停在 `proc !== null`
     * 的"在跑"状态：不重启、永远没有帧，取流端等满 15 秒首块超时拿到 504，
     * #status 还报告 streaming=true，要等空闲自停（默认 300 秒）才可能换台
     * 设备重新来过 —— 表现就是"面板黑屏，怎么点都没用"。
     *
     * 现在把失败当成一次崩溃处理：清状态、累加退避、按退避重试。
     */
    proc.child?.on?.("error", (error) => {
      if (!this.#resetProc(proc)) return;

      // spawn 失败时进程根本没建起来，kill 会抛；后来才出错（如 kill 失败）
      // 的情况则顺手收尸，避免留下僵尸子进程。
      try {
        proc.kill?.();
      } catch {
        // 没有可杀的进程
      }

      this.crashCount += 1;
      const reason = `${error?.code ?? ""} ${error?.message ?? error}`.trim();
      const delay = this.consumers.size > 0 ? this.#scheduleRestart() : 0;
      this.log(
        "warn",
        `流进程启动失败（${reason}）${
          delay > 0 ? `，${delay}ms 后重试` : "，暂无订阅者，不重启"
        }`,
      );
    });
  }

  /**
   * 把一个已经死掉的进程从会话状态里摘掉。
   *
   * 'exit' 与 'error' 两条路径共用：都只在"死掉的正是当前进程"时才生效
   * （避免已被替换的旧进程把新会话打回重启），并且在 stopping/stopped 时
   * 直接返回 false（终态不该再重启）。
   *
   * @param {object} proc spawnStream 的返回值
   * @returns {boolean} 是否应该继续走崩溃重试逻辑
   */
  #resetProc(proc) {
    if (this.proc !== proc) return false; // 已被替换
    this.proc = null;
    this.head = null;
    this.format = { kind: "unknown" };
    return !(this.stopping || this.stopped);
  }

  #killProc() {
    if (this.proc === null) return;
    const proc = this.proc;
    this.proc = null;
    this.head = null;
    this.format = { kind: "unknown" };
    try {
      proc.kill();
    } catch {
      // 已经退出
    }
  }

  #scheduleRestart() {
    this.#cancelRestart();
    // 退避：连续崩溃时拉长间隔，避免打爆设备端 agent
    const delay = Math.min(this.restartDelayMs * Math.max(1, this.crashCount), 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped || this.consumers.size === 0) return;
      this.#start();
    }, delay);
    // 计时器不该拖住进程退出
    this.restartTimer.unref?.();
    // 返回值只用于日志（"多少毫秒后重试"），调用方可以忽略
    return delay;
  }

  #cancelRestart() {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  #scheduleIdleStop() {
    this.#cancelIdleStop();
    if (this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.consumers.size > 0) return;
      this.log("info", `无消费者，停止流：${this.deviceId}`);
      // 注意：这里是"暂时停"，不是终态。stopping 临时置位以阻止重启，
      // 然后立刻复位，这样下次订阅还能重新拉起。
      this.stopping = true;
      this.#killProc();
      this.stopping = false;
      this.crashCount = 0;
    }, this.idleStopMs);
    this.idleTimer.unref?.();
  }

  #cancelIdleStop() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * 多设备会话池：按 deviceId 复用会话，切换设备时停掉旧的。
 */
export class StreamSessionPool {
  /**
   * @param {object} options
   * @param {(deviceId: string, options?: object) => {child: any, stdout: NodeJS.ReadableStream, stderr: () => string, kill: () => void}} options.spawnFor
   * @param {number} [options.idleStopMs]
   * @param {number} [options.restartDelayMs]
   * @param {number} [options.scaleRestartIntervalMs] 同设备两次"按新缩放重建"的最小间隔
   * @param {Function} [options.log]
   */
  constructor({ spawnFor, idleStopMs, restartDelayMs, scaleRestartIntervalMs = 3_000, log = () => {} }) {
    this.spawnFor = spawnFor;
    this.idleStopMs = idleStopMs;
    this.restartDelayMs = restartDelayMs;
    /**
     * 同一设备两次"按新缩放重建"的最小间隔（毫秒）。
     *
     * 为什么要节流：重建 = 杀掉编码器再起一条，中间有一段没有帧的黑场。
     * 面板宽度是连续变的（拖窗口、跨屏、DPR 变化），客户端也可能同时开着
     * 两个消费者各自上报宽度 —— 不节流就会来回杀，表现为画面反复黑一下。
     * 3 秒足够让一次真实的面板尺寸变化走完，又不会把连续拖拽变成连环重建。
     */
    this.scaleRestartIntervalMs = scaleRestartIntervalMs;
    this.log = log;
    /** @type {Map<string, StreamSession>} */
    this.sessions = new Map();
    /** 按设备记最近一次"按新缩放重建"的时间戳（节流用）。 */
    this.lastScaleRestartAt = new Map();
  }

  /**
   * 取（或建）某个设备的会话。
   *
   * @param {string} deviceId
   * @param {object} [options] 透传给 spawnFor 的流参数（`scale` 等），可缺省
   * @param {number} [options.scale] 编码缩放（1 = 原分辨率）
   * @param {boolean} [options.restart] 是否允许"缩放变化足够大就重建"
   *   ⚠️ 只有 `#grant` 该传 true。`/stream` **绝不能**传 —— 每开一个消费者
   *   就杀一次编码器，等于把"重连"变成"重启"，画面会一直黑。
   * @returns {StreamSession}
   */
  acquire(deviceId, options = {}) {
    const existing = this.sessions.get(deviceId);

    if (existing !== undefined && !existing.stopped) {
      const verdict = this.#restartVerdict(deviceId, existing, options);
      if (verdict.restart) {
        this.log("info", `按新缩放重建流：${deviceId} ${existing.scale} → ${options.scale}`);
        this.lastScaleRestartAt.set(deviceId, Date.now());
        // stop 会结束挂在旧流上的 HTTP 响应，客户端据此立刻重连到新会话
        this.stop(deviceId);
      } else {
        if (verdict.reason === "deferred" && typeof options.scale === "number" && options.scale !== existing.scale) {
          /**
           * 参数变了但**不重启**正在跑的流。
           *
           * 面板宽度会随窗口拖拽连续变化，每变一次就 kill 编码器意味着再来一段
           * IDR 前的花屏/黑屏，而收益只是"少解一点像素"—— 不值。新参数在下一个
           * 会话自然生效（面板关闭会 stop、切设备也会 stop），或者等客户端下一次
           * 带着明显更大的宽度来 grant（那时由 #grant 传 restart: true）。
           */
          this.log("info", `会话已在运行，缩放变化延后生效（${existing.scale} → ${options.scale}）：${deviceId}`);
        } else if (verdict.reason === "throttled") {
          this.log("info", `缩放重建节流中，稍后再试（${existing.scale} → ${options.scale}）：${deviceId}`);
        }
        return existing;
      }
    }

    const session = new StreamSession({
      deviceId,
      spawn: () => this.spawnFor(deviceId, options),
      scale: options.scale,
      idleStopMs: this.idleStopMs,
      restartDelayMs: this.restartDelayMs,
      log: this.log,
    });
    this.sessions.set(deviceId, session);
    return session;
  }

  /**
   * 判断这次 acquire 要不要为新的 scale 重建会话。
   *
   * 三道闸，缺一不可：
   *   ① `options.restart === true` —— 调用方明确允许（/stream 不允许）
   *   ② 缩放差异 > `SCALE_RESTART_RATIO`（1%）—— **双向**：变大时不为清晰度妥协，
   *      变小时调用方（#grant）已按更宽的 `SCALE_DOWNGRADE_RATIO` 判过值不值；
   *      这里只做"差异小到只是量化回差"的兜底，不区分方向；
   *   ③ 距上次重建 ≥ `scaleRestartIntervalMs`（3 秒）：挡住连续拖拽/多消费者抖动，
   *      两个方向共用一个窗口 —— 一升一降本来也不该在 3 秒内连做两次。
   *
   * @returns {{restart: boolean, reason: "restart"|"deferred"|"throttled"|"noop"}}
   */
  #restartVerdict(deviceId, existing, options) {
    const next = options.scale;
    const current = existing.scale;

    if (options.restart !== true) return { restart: false, reason: "deferred" };
    if (typeof next !== "number" || !Number.isFinite(next) || next <= 0) return { restart: false, reason: "noop" };
    if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) return { restart: false, reason: "noop" };

    const ratio = Math.max(current, next) / Math.min(current, next);
    if (ratio <= SCALE_RESTART_RATIO) return { restart: false, reason: "deferred" };

    const last = this.lastScaleRestartAt.get(deviceId);
    if (last !== undefined && Date.now() - last < this.scaleRestartIntervalMs) {
      return { restart: false, reason: "throttled" };
    }

    return { restart: true, reason: "restart" };
  }

  /** 停掉某个设备的流（切换设备、按新缩放重建时调用）。 */
  stop(deviceId) {
    const session = this.sessions.get(deviceId);
    if (session === undefined) return;
    session.stop();
    this.sessions.delete(deviceId);
  }

  /** 停掉全部。插件卸载时调用。 */
  stopAll() {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
