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
   * @param {Function} [options.log]
   */
  constructor({ deviceId, spawn, idleStopMs = 300_000, restartDelayMs = 5_000, log = () => {} }) {
    this.deviceId = deviceId;
    this.spawnFn = spawn;
    this.idleStopMs = idleStopMs;
    this.restartDelayMs = restartDelayMs;
    this.log = log;

    /** @type {Set<(chunk: Buffer) => void>} */
    this.consumers = new Set();
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
   * @returns {{remove: () => void, format: () => object, head: () => Buffer|null}}
   */
  addConsumer(onChunk) {
    if (this.stopped) {
      throw new Error(`stream session for ${this.deviceId} is stopped`);
    }

    this.consumers.add(onChunk);
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
        if (this.consumers.size === 0) this.#scheduleIdleStop();
      },
      format: () => this.format,
      head: () => this.head,
    };
  }

  /** 停止并进入终态。用于插件卸载、切换设备。 */
  stop() {
    this.stopping = true;
    this.stopped = true;
    this.#cancelIdleStop();
    this.#cancelRestart();
    this.#killProc();
    this.consumers.clear();
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
      if (this.proc !== proc) return; // 已被替换
      this.proc = null;
      this.head = null;
      this.format = { kind: "unknown" };

      if (this.stopping || this.stopped) return;

      this.crashCount += 1;
      const detail = proc.stderr?.() ?? "";
      this.log(
        "warn",
        `流进程退出（code=${code} signal=${signal}）${detail === "" ? "" : `：${detail.slice(0, 200)}`}`,
      );
      // 还有人订阅才重启；没人订阅就等下次 addConsumer
      if (this.consumers.size > 0) this.#scheduleRestart();
    });
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
   * @param {(deviceId: string) => {child: any, stdout: NodeJS.ReadableStream, stderr: () => string, kill: () => void}} options.spawnFor
   * @param {number} [options.idleStopMs]
   * @param {number} [options.restartDelayMs]
   * @param {Function} [options.log]
   */
  constructor({ spawnFor, idleStopMs, restartDelayMs, log = () => {} }) {
    this.spawnFor = spawnFor;
    this.idleStopMs = idleStopMs;
    this.restartDelayMs = restartDelayMs;
    this.log = log;
    /** @type {Map<string, StreamSession>} */
    this.sessions = new Map();
  }

  /**
   * 取（或建）某个设备的会话。
   * @param {string} deviceId
   * @returns {StreamSession}
   */
  acquire(deviceId) {
    const existing = this.sessions.get(deviceId);
    if (existing !== undefined && !existing.stopped) return existing;

    const session = new StreamSession({
      deviceId,
      spawn: () => this.spawnFor(deviceId),
      idleStopMs: this.idleStopMs,
      restartDelayMs: this.restartDelayMs,
      log: this.log,
    });
    this.sessions.set(deviceId, session);
    return session;
  }

  /** 停掉某个设备的流（切换设备时调用）。 */
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
