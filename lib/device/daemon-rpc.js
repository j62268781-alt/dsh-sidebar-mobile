/**
 * 经 mobilecli daemon 的 unix socket 直接发 JSON-RPC。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * CLI 路径每条指令都要 `spawn` 一个 mobilecli 进程；POSIX npm shim 会启动
 * Node，而 Windows 会解析到平台原生 `.exe`。历史样本中进程启动开销 **~66ms**，
 * 加上 daemon/IPC 往返，一条 `io tap` 总共 **~104ms**。该数据不是 Windows SLA。
 * 实测（一加 12）：
 *
 *     CLI 路径   io tap                  104.2 ms
 *     RPC 路径   device.io.tap             7.3 ms   ← 快 93%
 *     CLI 路径   io swipe (duration 300) 411   ms（固定开销 111ms）
 *     RPC 路径   device.io.swipe (300)   314.9 ms（固定开销  14ms）
 *
 * ── 为什么不是 `mobilecli server start` ─────────────────────────────
 *
 * mobilecli 另有 `server start` 模式（HTTP + `/rpc`）。它也能做到个位数
 * 毫秒，但要额外管一个常驻 HTTP 服务：端口占用、绑定失败、会话过期、
 * 进程清理 —— 正是 ARCHITECTURE 里「为什么不用 server 模式」列出的三条。
 *
 * 在支持的 POSIX 环境，**daemon 本来就在运行**（CLI 每条命令都会把它拉起来，
 * 空闲 30 分钟自退），unix socket 直接吃 JSON-RPC。Windows 上 Node 访问 socket
 * 可能被系统拒绝；插件会停用 RPC 并回退 CLI。
 *
 *   · 可用时不需要新起任何进程（daemon 已有）
 *   · 不需要端口（unix domain socket）
 *   · 没有会话/过期概念
 *   · POSIX 权限天然收窄：socket 是 `srw-------`，只有本用户能连
 *
 * 也就是说，在支持的平台上它拿到了 server 模式的低延迟，却没有额外运维负担。
 *
 * ── 协议细节（都是实测出来的）────────────────────────────────────────
 *
 *   · 传输是 **newline-delimited JSON**：写一行 JSON + `\n`，daemon 回一行。
 *     不是 HTTP —— 用 `curl --unix-socket` 会被拒（回 "HTTP/0.9 not allowed"）。
 *   · **一请求一连接**：daemon 回完响应就**主动关闭** socket。连发多个请求
 *     只有第一个会被回复（实测发 3 个只回 1 个，然后连接被关）。
 *     所以这里每个请求新建连接 —— 约 7ms，仍然远快于 CLI 的 104ms。
 *   · 参数形状与 CLI 不同：CLI 用逗号串（`540,1800,540,900`），
 *     RPC 用独立字段（`x1/y1/x2/y2`）。传逗号串会被拒
 *     （`'x1' is required`）。
 *   · socket 路径 = `<MOBILECLI_HOME>/daemon.sock`，默认 `~/.mobilecli`。
 */

import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** 单次请求的默认超时。设备操作偶发慢，但 15s 足够。 */
const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_CLI_FALLBACK_CODES = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "EPERM"]);

/**
 * 连接层错误：socket 不存在 / 没人监听 / 被系统拒绝。
 *
 * 这一类错误说明"通道现在不可用"，**不**说明这条指令有没有被执行 ——
 * 所以只在确认连接未建立时才回退 CLI（见 isSafeCliFallbackError）。
 */
const CONNECTION_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EACCES", "EPERM"]);

/**
 * 通道不可用后的探测节奏：5s → 15s → 60s，之后一直按 60s 试。
 *
 * 为什么必须自愈：daemon 空闲 30 分钟自退，而 CLI 每次调用又会把它拉起来。
 * 所以"一次 ECONNREFUSED"（daemon 刚好退出）会让通道永久失效，此后整场
 * 会话的每次点击都退化成 CLI —— 实测 CLI 166ms vs RPC 19.8ms，慢 8.4 倍，
 * 这正是用户说的"点了没反应"。
 *
 * 探测本身很便宜：`daemon.status` 往返实测 **0.7ms**（对比 devices CLI 356ms），
 * 所以按这个节奏空转也完全无所谓。
 */
const RECOVERY_BACKOFF_MS = [5_000, 15_000, 60_000];

/** 探测用的最廉价方法（实测 0.7ms）。 */
const PROBE_METHOD = "daemon.status";

/** 探测超时：daemon 活着时 0.7ms 就回，2 秒足够判定"连得上但没响应"。 */
const PROBE_TIMEOUT_MS = 2_000;

export function isSafeCliFallbackError(error) {
  return SAFE_CLI_FALLBACK_CODES.has(error?.code) === true;
}


/**
 * 解析 daemon socket 的路径。
 *
 * 与 CLI 的规则一致：`MOBILECLI_HOME` 优先，否则 `~/.mobilecli`。
 * 插件配置里的 `home`（homeDir）也要传进来 —— 传了它，RPC 与 CLI 才
 * 指向同一个 daemon，否则两边会各连一个。
 *
 * @param {string|null} home MOBILECLI_HOME；null 用默认
 * @returns {string} socket 绝对路径
 */
export function resolveSocketPath(home = null) {
  const dir = home !== null && home !== "" ? home : join(homedir(), ".mobilecli");
  return join(dir, "daemon.sock");
}

/**
 * 一次 daemon RPC 调用。
 *
 * ⚠️ 每次调用都新建连接 —— 这是 daemon 的语义（它回完就关，见文件头）。
 * 不要试图复用连接：连发第二个请求会石沉大海，然后 EPIPE。
 *
 * @param {string} method 形如 `device.io.tap`
 * @param {object} params
 * @param {{socketPath: string, timeoutMs?: number}} options
 * @returns {Promise<any>} JSON-RPC 的 result
 */
export function callDaemon(method, params, { socketPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // destroy 而不是 end：daemon 已经关了，end 会留半个 socket
      try {
        socket.destroy();
      } catch {
        // 已关闭
      }
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`daemon 请求超时（${method}）`)),
      timeoutMs,
    );

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return; // 还没收到完整行

      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(reject, new Error(`daemon 返回了非 JSON：${buffer.slice(0, 120)}`));
        return;
      }

      if (message.error !== undefined) {
        // `data` 里是更具体的原因（如 device not found），优先用它
        const detail = message.error.data ?? message.error.message ?? "未知错误";
        finish(reject, new Error(String(detail)));
        return;
      }
      finish(resolve, message.result);
    });

    socket.on("error", (error) => {
      // ENOENT = daemon 没在跑；ECONNREFUSED = socket 文件在但进程没了
      finish(reject, error);
    });

    socket.on("close", () => {
      // 没拿到响应就被关（daemon 崩溃、或协议不符）
      finish(reject, new Error(`daemon 在响应前关闭了连接（${method}）`));
    });
  });
}

/**
 * 把插件的 `sendInput` 动作翻译成 daemon RPC。
 *
 * ⚠️ 参数形状与 CLI **不同**，别照抄 argv：
 *   CLI  `io swipe --device X 540,1800,540,900`（逗号串）
 *   RPC  `device.io.swipe {deviceId, x1, y1, x2, y2}`（独立字段）
 *
 * @param {{action: string, [key: string]: any}} input 与 sendInput 同一个形状
 * @returns {{method: string, params: object}|null} null = 这条动作没有 RPC 实现
 */
export function rpcForInput(input) {
  const deviceId = input.deviceId;
  switch (input.action) {
    case "tap":
      return { method: "device.io.tap", params: { deviceId, x: input.x, y: input.y } };
    case "longpress":
      return {
        method: "device.io.longpress",
        params: {
          deviceId,
          x: input.x,
          y: input.y,
          ...(input.duration === undefined ? {} : { duration: input.duration }),
        },
      };
    case "swipe":
      return {
        method: "device.io.swipe",
        params: {
          deviceId,
          x1: input.x1, y1: input.y1, x2: input.x2, y2: input.y2,
          ...(input.duration === undefined ? {} : { duration: input.duration }),
        },
      };
    case "text":
      return { method: "device.io.text", params: { deviceId, text: String(input.text ?? "") } };
    case "keys":
      return { method: "device.io.keys", params: { deviceId, keys: input.keys } };
    case "button":
      return { method: "device.io.button", params: { deviceId, button: String(input.name ?? "HOME") } };
    default:
      // 例如 rotate：daemon 没有 orientation 方法（实测 6 个候选名全部
      // "method not found"），调用方据此回退到 CLI。
      return null;
  }
}

/**
 * 把设备级动作翻译成 daemon RPC。
 *
 * home / back / power 都落在 `device.io.button`；**rotate 没有 RPC 实现**
 * （daemon 不暴露 orientation），返回 null 让调用方走 CLI。
 *
 * @param {string} action
 * @param {string} deviceId
 * @returns {{method: string, params: object}|null}
 */
export function rpcForDeviceAction(action, deviceId) {
  const BUTTONS = { home: "HOME", back: "BACK", power: "POWER" };
  const button = BUTTONS[action];
  if (button === undefined) return null; // rotate 等
  return { method: "device.io.button", params: { deviceId, button } };
}

/**
 * 一个带**自愈**的 RPC 通道。
 *
 * ── 为什么必须自愈 ──────────────────────────────────────────────────
 *
 * daemon 空闲 30 分钟会自己退出，而 CLI 的任何设备类命令又会把它拉起来。
 * 也就是说"通道暂时连不上"是**常态**，不是永久故障。
 *
 * 旧实现把连接层失败当成永久结论（`#available = false`，而 `reset()` 在
 * 生产代码里根本没人调用）：一次 daemon 自退撞上点击，整场会话此后就全走
 * CLI —— 实测 CLI 166ms vs RPC 19.8ms，**慢 8.4 倍**。用户感受就是
 * "刚才还行，怎么越点越卡"。
 *
 * 所以这里做两件事：
 *   ① 失效后按 5s → 15s → 60s 的退避自动探测恢复；
 *   ② 探测用 `daemon.status`（实测往返 0.7ms，对比 `devices` CLI 356ms），
 *      空转成本可以忽略。
 *
 * 业务错误（设备忙、坐标非法）**不**动可用性：那说明通道是通的。
 */
export class DaemonRpc {
  /** @type {string} */
  #socketPath;
  /** @type {number} */
  #timeoutMs;
  /** @type {boolean} 连接层失败后置 false，探测成功后自动恢复 */
  #available = true;
  /** @type {Function} */
  #log;
  /** @type {NodeJS.Timeout|null} 下一次探测的定时器 */
  #recoveryTimer = null;
  /** @type {number} 已安排的探测次数，用于取退避档位 */
  #recoveryAttempt = 0;
  /** @type {boolean} 探测进行中，避免重叠 */
  #probing = false;
  /** @type {number[]} 恢复探测的退避档位（可用构造参数覆盖，便于构造用例） */
  #recoveryBackoff = RECOVERY_BACKOFF_MS;

  /**
   * @param {{home?: string|null, timeoutMs?: number, log?: Function, recoveryBackoffMs?: number[]}} [options]
   *   `recoveryBackoffMs` 只给测试用：真实退避是 5s/15s/60s，用例等不起。
   */
  constructor({
    home = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = () => {},
    recoveryBackoffMs = null,
  } = {}) {
    this.#socketPath = resolveSocketPath(home);
    this.#timeoutMs = timeoutMs;
    this.#log = log;
    this.#recoveryBackoff = Array.isArray(recoveryBackoffMs) && recoveryBackoffMs.length > 0
      ? recoveryBackoffMs
      : RECOVERY_BACKOFF_MS;
  }

  get socketPath() {
    return this.#socketPath;
  }

  get available() {
    return this.#available;
  }

  /** 立刻恢复可用（CLI 兜底已证明 daemon 活着时用它，见 routes.js）。 */
  reset() {
    this.#cancelRecovery();
    this.#recoveryAttempt = 0;
    if (!this.#available) {
      this.#log("info", `daemon RPC 通道恢复：${this.#socketPath}`);
    }
    this.#available = true;
  }

  /**
   * 廉价预热：探一次 `daemon.status`，通了就把通道标为可用。
   *
   * 面板打开时调用，目的是消掉"第一次点击必然走 CLI"（冷启动时 socket 还没
   * 生成，CLI 又要 166ms）。永不抛错 —— 预热失败只是"这次没提前通"。
   *
   * @returns {Promise<boolean>} 通道当前是否可用
   */
  async prewarm() {
    if (this.#probing) return this.#available;

    this.#probing = true;
    try {
      await callDaemon(PROBE_METHOD, {}, {
        socketPath: this.#socketPath,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      this.reset();
      return true;
    } catch (error) {
      if (CONNECTION_CODES.has(error?.code) || error?.code === "ETIMEDOUT") {
        this.#markUnavailable(error?.code ?? "ETIMEDOUT");
      }
      return this.#available;
    } finally {
      this.#probing = false;
    }
  }

  /**
   * 调一次。失败会**抛出**；调用方只对确认连接前失败的错误回退 CLI，
   * 以避免响应丢失时重复执行设备动作。
   * 只有连接层错误会把通道标记为不可用（并安排自动探测恢复）；
   * 业务错误不该让整条通道停用。
   *
   * @param {string} method
   * @param {object} params
   * @returns {Promise<any>}
   */
  async call(method, params) {
    if (!this.#available) throw new Error("daemon RPC 通道已标记为不可用");
    try {
      return await callDaemon(method, params, {
        socketPath: this.#socketPath,
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      if (CONNECTION_CODES.has(error?.code)) this.#markUnavailable(error.code);
      throw error;
    }
  }

  /**
   * 标记通道不可用并安排恢复探测。
   * @param {string} code 触发失效的错误码（用于日志）
   */
  #markUnavailable(code) {
    if (!this.#available) return; // 已经在退避中，别刷日志
    this.#available = false;
    this.#log("warn", `daemon socket 不可用（${code}），交互改用 CLI，并开始自动重连：${this.#socketPath}`);
    this.#scheduleRecovery();
  }

  /** 按 5s → 15s → 60s（封顶）安排下一次探测。 */
  #scheduleRecovery() {
    if (this.#recoveryTimer !== null) return;

    const index = Math.min(this.#recoveryAttempt, this.#recoveryBackoff.length - 1);
    const delay = this.#recoveryBackoff[index];
    this.#recoveryAttempt += 1;

    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null;
      void this.#probe();
    }, delay);
    // 退避定时器不该拖住进程退出（插件卸载/测试结束时必须能立刻走）
    this.#recoveryTimer.unref?.();
  }

  #cancelRecovery() {
    if (this.#recoveryTimer === null) return;
    clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = null;
  }

  /** 探测一次；失败就继续按退避重试。 */
  async #probe() {
    if (this.#available || this.#probing) return;

    this.#probing = true;
    try {
      await callDaemon(PROBE_METHOD, {}, {
        socketPath: this.#socketPath,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      this.reset();
    } catch {
      // 还没起来：继续退避（daemon 可能要到下次 CLI 调用才被拉起）
      this.#scheduleRecovery();
    } finally {
      this.#probing = false;
    }
  }
}
