/**
 * 流路由：把 mobilecli 的画面与控制经 DSH 自己的 web 源暴露给面板。
 *
 * 所有路由挂在 `/_dsh/dsh-sidebar-mobile/*` 前缀下，浏览器只用
 * 这一个源，从不接触 mobilecli 的端口。
 *
 * 路由表：
 *   POST grant          申请 token（先过同源 + loopback 围栏）
 *   GET  stream/<token> 取实时流（MJPEG 或 H.264，取决于平台）
 *   POST devices        设备列表
 *   POST switch-device  切换当前设备
 *   POST control        转发点击/滑动/文本
 *   POST device-action  home / back / 旋转
 *   GET  status         会话状态（面板心跳）
 *
 * ── 为什么 grant 是 POST 而 stream 是 GET ─────────────────────────────
 * `<img>` 与 `<video>` 只能发 GET，所以取流必须是 GET，token 只能走 URL。
 * 而申请 token 是状态变更（要选设备、要签新令牌），用 POST 才能带上
 * Origin 校验——这是浏览器能提供的、curl 伪造不了的那层保护。
 *
 * ── 响应体大小限制 ────────────────────────────────────────────────────
 * 控制类 POST 的 body 都是小 JSON。这里硬限 64KB，避免畸形请求把内存吃满。
 *
 * @module dsh-sidebar-mobile/lib/stream-routes
 */

import {
  ROUTES,
  checkTransportFence,
  isSameOriginRequest,
} from "./access.js";
import { describeAdbProblem } from "../device/android-toolchain.js";
import { DaemonRpc, rpcForInput, rpcForDeviceAction } from "../device/daemon-rpc.js";

/** POST body 上限。控制指令都是小 JSON，64KB 绰绰有余。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 启动一台模拟器/模拟机的超时。
 *
 * 冷启动要跑完整个 Android/iOS 开机流程，实测可达数分钟，所以给 5 分钟
 * （与 mobile_boot 工具一致）。面板侧会一直等这条 grant 响应，所以
 * 这里不能短 —— 短了会把"正在启动"误报成失败。
 */
const BOOT_TIMEOUT_MS = 300_000;

/**
 * 写缓冲积压阈值：超过就丢数据直到追上来。
 *
 * 实测 `ServerResponse.writableHighWaterMark` 是 **16KB**。留 16 倍余量
 * （256KB）既能吸收正常的突发，又不会让延迟累积到肉眼可见 —— 按 8Mbps
 * 算，256KB ≈ 0.26 秒的画面，属于可接受的抖动范围。
 */
const BACKPRESSURE_LIMIT_BYTES = 256 * 1024;

/**
 * 找第一个 Annex B 起始码（00 00 01 或 00 00 00 01）的位置。
 *
 * 用于拥塞丢弃后**重新对齐**：从这个位置开始投递，客户端一定能正确分帧。
 *
 * ⚠️ **只对 H.264 有效**。MJPEG 的 JPEG 像素数据里天然会大量出现
 * `00 00 01` 序列（实测 36MB 流里有 1925 个三字节 + 3465 个四字节），
 * 它们落在数据内部、不是任何边界。MJPEG 必须按 boundary 对齐
 * （见 findBoundary / lastBoundary）。
 *
 * @param {Buffer} buf
 * @returns {number} 起始码下标；没有则 -1
 */
export function findStartCode(buf) {
  const end = buf.length - 3;
  for (let i = 0; i <= end; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    if (buf[i + 2] === 1) return i;
    if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1) return i;
  }
  return -1;
}

/**
 * 找**最后一个**起始码的位置 —— 即"最后一个完整访问单元的起点"。
 *
 * 拥塞时投递到它为止：前面的数据都是完整访问单元，后面的部分丢掉，
 * 于是被投递的最后一段也是一个完整单元，不会留下半截 NAL。
 *
 * ⚠️ 只认**明确完整**的起始码：4 字节形式要求 i+3 还在缓冲区内，避免把
 * 恰好跨在块尾的 `00 00 00` 误判成起始码。
 *
 * ⚠️ 同 findStartCode：**只对 H.264 有效**，别用在 MJPEG 上。
 *
 * @param {Buffer} buf
 * @returns {number} 起始码下标；没有则 -1
 */
export function lastStartCode(buf) {
  let found = -1;
  const end = buf.length - 3;
  for (let i = 0; i <= end; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    if (buf[i + 2] === 1) {
      found = i;
      i += 2;
      continue;
    }
    if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1) {
      found = i;
      i += 3;
    }
  }
  return found;
}

/**
 * 找第一个 multipart boundary 的位置 —— MJPEG 的对齐点。
 *
 * MJPEG 是 `multipart/x-mixed-replace`：每帧形如
 * `--<boundary>\r\n<headers>\r\n\r\n<jpeg 字节>\r\n`。浏览器只在读到
 * **下一个 boundary** 时才认为上一帧结束，所以投递必须停在 boundary 上；
 * 否则最后一帧永远等不到结束标记（不渲染），恢复投递后的残余字节也会
 * 被当成上一帧的像素（该帧损坏）。
 *
 * 实测依据：iOS 模拟器 MJPEG 21.8 Mbps、每帧 ~35KB，而背压阈值是 256KB
 * —— 积压约 7 帧就触发丢弃。这条路径是日常会走到的，不是边角情况。
 *
 * @param {Buffer} buf
 * @param {string} boundary 形如 `--mjpeg-frame-boundary`（含前导 `--`）
 * @returns {number} boundary 下标；没有则 -1
 */
export function findBoundary(buf, boundary) {
  return buf.indexOf(boundary, 0, "latin1");
}

/**
 * 找**最后一个** multipart boundary 的位置。
 *
 * 与 lastStartCode 同理：投递到它为止，被投递的部分以完整帧结尾。
 *
 * @param {Buffer} buf
 * @param {string} boundary 形如 `--mjpeg-frame-boundary`（含前导 `--`）
 * @returns {number} boundary 下标；没有则 -1
 */
export function lastBoundary(buf, boundary) {
  return buf.lastIndexOf(boundary, buf.length, "latin1");
}

/** 流本身的响应头。禁用一切缓存，否则面板会显示过期画面。 */
const STREAM_HEADERS = {
  "cache-control": "no-store, no-cache, must-revalidate",
  "connection": "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * 读取并解析 JSON body。
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 发一个 JSON 响应。
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * 发一个纯文本错误。用于围栏拒绝——此时不该回 JSON，因为请求方
 * 连自己打的是哪个插件都不一定知道。
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

/**
 * 把流会话的字节接到 HTTP 响应上。
 *
 * 首块必须等：格式（MJPEG boundary 还是 H.264）由首块嗅探得出，
 * 响应头里的 content-type 依赖它。等不到首块就返回 504，
 * 而不是先发一个 content-type: unknown 的头再改。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {import("./stream-session.js").StreamSession} session
 * @param {number} [firstByteTimeoutMs]
 * @returns {Promise<void>}
 */
async function pipeStreamToResponse(res, session, firstByteTimeoutMs = 15_000) {
  /** @type {{remove: () => void}|null} */
  let subscription = null;
  let closed = false;
  /** 首块到达前不能写响应头——格式还没嗅探出来。 */
  let headersWritten = false;
  /**
   * 是否处于"拥塞丢弃"状态。
   *
   * 一旦进入，就一直丢到遇见下一个起始码为止 —— 保证恢复投递的位置落在
   * 访问单元边界上（见回调里那段注释）。
   */
  let dropping = false;

  const cleanup = () => {
    if (subscription !== null) {
      subscription.remove();
      subscription = null;
    }
  };

  /** 等首块到达（或超时 / 客户端断开）。 */
  const firstFrame = new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, firstByteTimeoutMs);

    // 客户端在首块到达前就断开（用户关面板）
    res.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closed = true;
      resolve(false);
    });

    // ⚠️ 只注册一个消费者，它的回调**既写首块也写后续块**。
    //
    // 曾经的做法是「首块消费者 resolve 后再注册第二个消费者转发剩余」，
    // 那有两个真实的 bug：
    //   ① 首块消费者从不注销 → consumers.size 永不归零 →
    //      空闲自停永不触发 → 面板关掉后设备一直编码（耗电、占 USB 带宽）
    //   ② 注册第二个消费者时，StreamSession.addConsumer 会把已缓存的
    //      head 回放给它，于是首块被写进响应两次 → 码流里多一个重复 NAL
    // 一个消费者同时干两件事就没有这两个窗口。
    subscription = session.addConsumer((chunk) => {
      if (closed) return;

      if (!headersWritten) {
        headersWritten = true;
        clearTimeout(timer);
        // 格式由会话从首块字节嗅探得出，不信任我们请求了什么
        const format = session.format;
        res.writeHead(200, {
          ...STREAM_HEADERS,
          "content-type": format.contentType ?? "application/octet-stream",
        });
        if (!settled) {
          settled = true;
          resolve(true);
        }
      }

      // ── 背压：积压时丢数据，但**必须丢在帧边界上** ────────────────────
      //
      // 三个教训，都是实测得来的：
      //
      // ① 阈值原本是 4MB，而实测 `ServerResponse.writableHighWaterMark`
      //    只有 **16KB** —— 4MB 是它的 256 倍。等它生效，画面早就落后几秒，
      //    "实时"已经没有意义。降到 256KB（16 倍 hwm）才既留出突发余量，
      //    又能在真正拥塞时及时减负。
      //
      // ② 更重要的是**在哪里丢**。chunk 是 stdout 的原始 data 事件，
      //    边界完全任意，跟 NAL/帧没有任何对应关系。直接 `return` 丢掉一个
      //    chunk，就是把当前 NAL 拦腰截断：客户端按起始码切分（splitAnnexB），
      //    会把这半截和下一个 NAL 粘成一个坏单元 → decode 抛错 →
      //    客户端丢弃所有非关键帧等下一个 IDR（实测间隔可达 3–4 秒）→
      //    表现就是**花屏之后卡住几秒**。
      //
      //    所以拥塞时不能"丢当前块"，而要"从下一个帧起点开始丢" ——
      //    这样码流在每个被跳过区间的首尾都落在帧边界上，客户端总能重新对齐。
      //
      // ③ **两种格式的"帧边界"不是一回事，必须分开找**：
      //      H.264 → Annex B 起始码 00 00 01 / 00 00 00 01
      //      MJPEG → multipart boundary（`--<boundary>`）
      //    早先两种格式共用起始码逻辑，这在 MJPEG 上是**错的**：
      //    JPEG 像素数据里天然大量出现 00 00 01（实测 36MB 流里 1925+3465 个），
      //    按它截断会切出不含 boundary 的半截 JPEG → 该帧永远等不到结束标记
      //    （浏览器不渲染），恢复投递后的残余字节还会被当成上一帧的像素。
      //    MJPEG 实测 21.8 Mbps、每帧 ~35KB，而阈值 256KB —— 积压约 7 帧就触发，
      //    所以这条路径是日常会走到的，不是边角情况。
      const boundary = session.format.kind === "mjpeg" ? session.format.boundary : null;

      if (dropping) {
        // 丢弃中：只找帧边界。找到就从这里恢复投递（含边界本身）。
        const resumeAt = boundary === null
          ? findStartCode(chunk)
          : findBoundary(chunk, boundary);
        if (resumeAt === -1) return; // 整块都在被丢的那段里
        dropping = false;
        chunk = chunk.subarray(resumeAt);
      } else if (res.writableLength > BACKPRESSURE_LIMIT_BYTES) {
        // 进入丢弃态：本块只投递到最后一个完整帧的结尾，其余丢掉。
        const cut = boundary === null
          ? lastStartCode(chunk)
          : lastBoundary(chunk, boundary);
        if (cut <= 0) {
          // 整块都不含可对齐的边界 → 整块丢掉，等下一块的边界
          dropping = true;
          return;
        }
        chunk = chunk.subarray(0, cut);
        dropping = true;
      }

      try {
        res.write(chunk);
      } catch {
        closed = true;
        cleanup();
      }
    });

    res.on("close", () => {
      closed = true;
      cleanup();
    });
  });

  const ok = await firstFrame;

  if (!ok) {
    cleanup();
    if (!res.headersSent) {
      sendText(res, 504, "device stream did not produce a first frame in time");
    } else {
      res.end();
    }
    return;
  }

  // 首块已经写过响应头，这里只需等连接结束
  await new Promise((resolve) => {
    if (closed) return resolve();
    res.on("close", resolve);
    res.on("finish", resolve);
    return undefined;
  });
  cleanup();
}

/**
 * 插件路由的实现体。与 DSH 的 webServer 解耦，便于单测直接调用。
 */
export class StreamRoutes {
  /**
   * @param {object} options
   * @param {import("./mobilecli.js").Mobilecli} options.client
   * @param {import("./stream-session.js").StreamSessionPool} options.pool
   * @param {import("./stream-access.js").StreamAccessController} options.access
   * @param {{host: string, port: number|null, scheme: string|null}[]} [options.trustedAuthorities]
   * @param {object} [options.adbProbe] Android 工具链体检器（见 android-toolchain.js）
   * @param {Function} [options.log]
   */
  constructor({ client, pool, access, trustedAuthorities = [], adbProbe = null, log = () => {}, rpc = null }) {
    this.client = client;
    this.pool = pool;
    this.access = access;
    this.trustedAuthorities = trustedAuthorities;
    /** adb 体检器。null 时退化为不诊断（测试环境）。 */
    this.adbProbe = adbProbe;
    this.log = log;
    /**
     * daemon unix socket 的 JSON-RPC 通道。
     *
     * 交互指令优先走它：实测 `device.io.tap` 7.3ms vs CLI 的 104.2ms
     * —— 省掉每条命令约 66ms 的 node 进程启动。null 时全部走 CLI。
     * 见 lib/daemon-rpc.js。
     */
    this.rpc = rpc;
    /** 当前面板正在看的设备。null 表示还没选。 */
    this.activeDeviceId = null;

    /**
     * 「请把面板打开」的请求状态。
     *
     * 为什么要这么绕：工具跑在 **Host** 进程里，侧边栏在 **浏览器** 里。
     * DSH 没有给客户端插件一条通用的 host→client 推送通道（SSE/WebSocket
     * 只存在于 ACP 那条线），所以只能由客户端主动来问。
     *
     * 两个设计点：
     *   ① 用**长轮询**而不是定频心跳：空闲时挂着一条连接、零重复请求，
     *      请求到来时立刻返回，两端都省。
     *   ② 轮询发起在**插件加载时**（客户端 apply()），不是面板挂载后 ——
     *      否则"打开一个还没打开的面板"永远等不到人来问。
     *
     * seq 单调递增，客户端只需记住上次处理过的号，天然幂等。
     */
    this.panelOpenSeq = 0;
    /** 尚未被回执确认的请求号；null 表示当前没有待处理请求。 */
    this.panelOpenPending = null;
    /** 挂起中的长轮询响应；请求到来或超时时唤醒。 */
    this.panelOpenWaiters = new Set();
    /** 等回执的 resolve 函数集合（工具侧在等）。 */
    this.panelOpenAckWaiters = new Set();
  }

  /**
   * 请求客户端把移动设备面板打开，并等它的回执。
   *
   * 由 `mobile_open_panel` 工具调用。返回后调用方就知道面板**确实**被打开了
   * —— 而不是"请求已发出，不知道有没有人听"。
   *
   * @param {number} timeoutMs 等回执的上限
   * @returns {Promise<{ opened: boolean, waitedMs: number, reason?: string }>}
   */
  async requestPanelOpen(timeoutMs = 10_000) {
    const startedAt = Date.now();
    this.panelOpenSeq += 1;
    const seq = this.panelOpenSeq;
    this.panelOpenPending = seq;

    // 唤醒所有挂着的长轮询：它们会看到待处理请求并立刻把号带回去
    for (const wake of [...this.panelOpenWaiters]) wake();

    const acked = await new Promise((resolve) => {
      let timer = null;
      const onAck = () => {
        if (timer !== null) clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        this.panelOpenAckWaiters.delete(onAck);
        resolve(false);
      }, timeoutMs);
      // 别让这个定时器撑住进程退出
      if (typeof timer.unref === "function") timer.unref();
      this.panelOpenAckWaiters.add(onAck);
    });

    const waitedMs = Date.now() - startedAt;
    if (acked && this.panelOpenPending === seq) {
      this.panelOpenPending = null;
      return { opened: true, waitedMs };
    }
    return {
      opened: false,
      waitedMs,
      reason:
        "客户端没有回执。通常是 DSH 网页没开着，或这个 profile 里没加载插件的客户端半边。",
    };
  }

  /**
   * 长轮询：客户端问"有没有要把面板打开的请求？"。
   *
   * 有待处理请求 → 立刻返回它的号；否则挂起，直到有请求或超时（返回 null）。
   * 超时时间刻意小于任何可能的上游请求超时，让连接正常结束而不是被掐断。
   */
  async #panelOpen(req, res) {
    if (req.method !== "GET") return this.#methodNotAllowed(res, "GET");

    const held = this.panelOpenPending;
    if (held !== null) {
      sendJson(res, 200, { request: held });
      return true;
    }

    const HOLD_MS = 20_000;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.panelOpenWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(finish, HOLD_MS);
      if (typeof timer.unref === "function") timer.unref();
      const wake = () => finish();
      this.panelOpenWaiters.add(wake);
      // 客户端提前断开（刷新页面、关标签）也要收敛，否则这个 Promise 会
      // 挂满 HOLD_MS，连接对象一直留着。
      res.on("close", finish);
    });

    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 200, { request: this.panelOpenPending });
    }
    return true;
  }

  /** 客户端回执：面板已打开。 */
  async #panelOpenAck(req, res) {
    if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");

    const body = await readJsonBody(req);
    const seq = Number(body?.request ?? 0);
    if (seq !== this.panelOpenPending) {
      // 迟到的回执（比如上一次请求超时后才到）不算数，但也别报错
      sendJson(res, 200, { ok: true, stale: true });
      return true;
    }

    for (const onAck of [...this.panelOpenAckWaiters]) onAck();
    sendJson(res, 200, { ok: true });
    return true;
  }

  /**
   * 处理一次请求。
   *
   * @param {string} routeName ROUTES 里的名字
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<boolean>} 是否已处理（false 交给上层 404）
   */
  async handle(routeName, req, res) {
    // ① 传输层围栏：先于一切能力检查
    const fence = checkTransportFence(req, this.trustedAuthorities);
    if (!fence.ok) {
      this.log("warn", `拒绝请求（${routeName}）：${fence.reason}`);
      sendText(res, 403, "forbidden");
      return true;
    }

    // ② 状态变更类请求要求同源
    if (req.method === "POST" && !isSameOriginRequest(req)) {
      this.log("warn", `拒绝跨站 POST（${routeName}）`);
      sendText(res, 403, "cross-origin request rejected");
      return true;
    }

    try {
      switch (routeName) {
        case ROUTES.grant:
          return await this.#grant(req, res);
        case ROUTES.stream:
          return await this.#stream(req, res);
        case ROUTES.devices:
          return await this.#devices(req, res);
        case ROUTES.switchDevice:
          return await this.#switchDevice(req, res);
        case ROUTES.control:
          return await this.#control(req, res);
        case ROUTES.deviceAction:
          return await this.#deviceAction(req, res);
        case ROUTES.status:
          return await this.#status(req, res);
        case ROUTES.panelOpen:
          return await this.#panelOpen(req, res);
        case ROUTES.panelOpenAck:
          return await this.#panelOpenAck(req, res);
        default:
          return false;
      }
    } catch (error) {
      // 路由体绝不把异常抛给 Host：DSH 会在加载期或通道处理抛出未捕获异常时
      // 隔离整个 profile。所有失败都在这里收敛成响应。
      this.log("error", `路由 ${routeName} 失败：${error?.stack ?? error}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
      } else {
        res.end();
      }
      return true;
    }
  }

  // ── 各路由 ──────────────────────────────────────────────────────────

  /**
   * 申请 token。请求体可带 deviceId；不带则用当前设备或第一台在线设备。
   */
  async #grant(req, res) {
    if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");

    const body = await readJsonBody(req);
    /**
     * ⚠️ 必须 `includeOffline: true` —— 与 #status（面板列表的来源）保持一致。
     *
     * 这里原先用的是默认值（不含离线），于是出现一个自相矛盾：
     * 面板的设备列表来自 #status（**含**离线，用户看得见那台关着的模拟器），
     * 但点它时走 #grant（**不含**离线）→ 查不到 → 回 "未找到设备：<id>"。
     * 用户视角就是"列表里明明有，点了却说没有"。
     *
     * 选中一台离线设备是**合法**操作：模拟器/模拟机可以先启动再串流
     * （`device boot`，见 #bootIfNeeded）。真机离线才需要用户去插线。
     */
    const devices = await this.client.listDevices({ includeOffline: true });
    const online = devices.filter((d) => d.state === "online");

    let deviceId = typeof body.deviceId === "string" && body.deviceId !== "" ? body.deviceId : null;

    if (deviceId === null) {
      // 优先沿用当前设备；它离线了就退回第一台在线的
      const stillOnline = online.some((d) => d.id === this.activeDeviceId);
      deviceId = stillOnline ? this.activeDeviceId : (online[0]?.id ?? null);
    } else if (!devices.some((d) => d.id === deviceId)) {
      sendJson(res, 404, { ok: false, error: `未找到设备：${deviceId}` });
      return true;
    }

    if (deviceId === null) {
      /**
       * ⚠️ 走到这里有两种**完全不同**的原因，必须区分开：
       *
       *   ① 真的没接设备（用户该去插线/开 USB 调试）
       *   ② adb 缺失或没被授权 —— 此时 mobilecli **静默返回空列表且 exit 0**，
       *      从它的 JSON 里完全看不出问题
       *
       * 实测 mobilecli 1.0.19：没有 adb 时 `devices` 返回
       * `{"status":"ok","data":{"devices":[]}}`、exit code 0，真相只在
       * daemon 日志（`Failed running 'adb devices'`）。
       *
       * 如果这里只说"没有在线设备 / 连一台开了调试的手机"，就会把用户
       * 指向错误方向（去换数据线、去翻开发者选项），而实际要做的是装 adb。
       * 所以空列表时补一次 Android 工具链体检，把真正的原因说出来。
       */
      const diagnosis = await this.#diagnoseEmptyDeviceList();
      sendJson(res, 409, {
        ok: false,
        error: diagnosis.message,
        hint: diagnosis.hint,
        code: diagnosis.code,
        adbPath: diagnosis.adbPath,
        devices,
        devicesFromMobilecli: devices.length,
      });
      return true;
    }

    // 切换设备时停掉上一条流，避免同时在编两路
    if (this.activeDeviceId !== null && this.activeDeviceId !== deviceId) {
      this.pool.stop(this.activeDeviceId);
    }
    this.activeDeviceId = deviceId;

    const device = devices.find((d) => d.id === deviceId);

    /**
     * 选中一台**离线**设备时顺手把它启动起来。
     *
     * 为什么放在这里而不是让用户先跑 `mobile_boot`：面板是可视化的入口，
     * 用户在下拉里点了一台关着的模拟器，预期就是"用它" —— 报一句
     * "设备离线"然后什么都不做，是把启动的负担推回给用户。
     *
     * ⚠️ 只有模拟器/模拟机可以这样启动（`device boot` 只对它们有效）。
     * 真机离线通常是没插线/USB 调试没开，boot 没有意义 —— 那种情况交给
     * 状态轮询去反映，面板会显示"离线"。
     *
     * 失败**不影响** grant 成功：设备照样被选中，错误写进 `bootError`，
     * 由面板显示。否则一次启动失败会让用户连选都选不中。
     */
    let bootError = null;
    const isVirtual = device?.type === "simulator" || device?.type === "emulator";
    if (device !== undefined && device.state !== "online" && isVirtual) {
      try {
        await this.client.runJson(["device", "boot", "--device", deviceId], {
          timeoutMs: BOOT_TIMEOUT_MS,
        });
        // 启动后状态变了，重新取一次，让面板立刻看到 online
        const fresh = await this.client.listDevices({ includeOffline: true, fresh: true });
        const updated = fresh.find((d) => d.id === deviceId);
        if (updated !== undefined) Object.assign(device, updated);
      } catch (error) {
        bootError = error?.message ?? String(error);
        this.log("warn", `启动设备失败（${deviceId}）：${bootError}`);
      }
    }

    sendJson(res, 200, {
      ok: true,
      device,
      devices,
      streamToken: this.access.mint(deviceId),
      expiresInMs: this.access.ttlMs,
      ...(bootError === null ? {} : { bootError }),
    });
    return true;
  }

  /** 取流。token 决定设备，URL 里的 token 与当前设备不一致就 409。 */
  async #stream(req, res) {
    if (req.method !== "GET") return this.#methodNotAllowed(res, "GET");

    const token = this.#tokenFromUrl(req);
    const verified = this.access.verify(token);
    if (!verified.ok) {
      sendText(res, 401, `unauthorized: ${verified.reason}`);
      return true;
    }

    const session = this.pool.acquire(verified.deviceId);
    await pipeStreamToResponse(res, session);
    return true;
  }

  /** 设备列表。 */
  async #devices(req, res) {
    if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");
    const devices = await this.client.listDevices({ includeOffline: true });
    sendJson(res, 200, { ok: true, devices, activeDeviceId: this.activeDeviceId });
    return true;
  }

  /** 切换设备。会停掉旧设备的流。 */
  async #switchDevice(req, res) {
    if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");
    const body = await readJsonBody(req);
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    if (deviceId === "") {
      sendJson(res, 400, { ok: false, error: "缺少 deviceId" });
      return true;
    }

    if (this.activeDeviceId !== null && this.activeDeviceId !== deviceId) {
      this.pool.stop(this.activeDeviceId);
    }
    this.activeDeviceId = deviceId;

    sendJson(res, 200, {
      ok: true,
      activeDeviceId: deviceId,
      streamToken: this.access.mint(deviceId),
    });
    return true;
  }

  /** 转发一次交互。 */
  async #control(req, res) {
    if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");

    const deviceId = this.#requireActiveDevice();
    if (deviceId === null) {
      sendJson(res, 409, { ok: false, error: "尚未选择设备" });
      return true;
    }

    const body = await readJsonBody(req);
    const action = typeof body.action === "string" ? body.action : "";
    const validation = validateInput(action, body);
    if (!validation.ok) {
      sendJson(res, 400, { ok: false, error: validation.error });
      return true;
    }

    const session = this.pool.acquire(deviceId);
    await this.#dispatchInput(session, deviceId, validation.input);
    sendJson(res, 200, { ok: true, action });
    return true;
  }

  /**
   * 执行一次交互：优先 daemon RPC，失败则回退 CLI。
   *
   * 为什么保留 CLI 兜底而不是全量切换：
   *   · daemon 可能没运行（socket 不在）或版本不支持 socket 协议；
   *   · `rotate` 这类动作 daemon **没有**对应方法（实测 6 个候选名全部
   *     "method not found"），只能走 CLI。
   * 所以 RPC 是加速路径，不是唯一路径 —— 任何情况下回退都不丢功能。
   *
   * @param {import("./stream-session.js").StreamSession} session
   * @param {string} deviceId
   * @param {object} input 已校验的输入
   */
  async #dispatchInput(session, deviceId, input) {
    const runCli = () => session.sendInput(
      (args) => this.client.runJson(args, { timeoutMs: 20_000 }),
      input,
    );

    if (this.rpc === null) return runCli();

    const mapped = rpcForInput({ ...input, deviceId });
    if (mapped === null) return runCli(); // 该动作没有 RPC 实现

    try {
      return await this.rpc.call(mapped.method, mapped.params);
    } catch (error) {
      /**
       * ⚠️ 这里**只回退、不掩盖**。
       *
       * 回退发生在两类情况：
       *   ① 连接层失败（daemon 没起）—— DaemonRpc 已自行标记不可用；
       *   ② 业务失败（设备不存在、手势被拒）—— 回退到 CLI 会以同样的
       *      原因再失败一次，最终抛出的错误与纯 CLI 路径一致。
       * 所以回退不改变对外语义，最坏只是多花一次 CLI 的时间。
       */
      this.log("warn", `RPC 失败，回退 CLI（${mapped.method}）：${error?.message ?? error}`);
      return runCli();
    }
  }

  /** 设备级动作：home / back / 旋转。 */
  async #deviceAction(req, res) {
    if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");

    const deviceId = this.#requireActiveDevice();
    if (deviceId === null) {
      sendJson(res, 409, { ok: false, error: "尚未选择设备" });
      return true;
    }

    const body = await readJsonBody(req);
    const action = typeof body.action === "string" ? body.action : "";
    const args = ["--device", deviceId];

    /**
     * home / back / power 都是 `device.io.button`，走 RPC 每位省约 97ms。
     * **rotate 没有 RPC 实现**（daemon 不暴露 orientation，实测多个候选
     * 方法名全部 method not found），rpcForDeviceAction 返回 null，
     * 于是照旧走 CLI。
     */
    const mapped = this.rpc === null ? null : rpcForDeviceAction(action, deviceId);
    if (mapped !== null) {
      try {
        await this.rpc.call(mapped.method, mapped.params);
        sendJson(res, 200, { ok: true, action });
        return true;
      } catch (error) {
        this.log("warn", `RPC 失败，回退 CLI（${action}）：${error?.message ?? error}`);
      }
    }

    switch (action) {
      case "home":
        await this.client.runJson(["io", "button", ...args, "HOME"]);
        break;
      case "back":
        await this.client.runJson(["io", "button", ...args, "BACK"]);
        break;
      case "power":
        await this.client.runJson(["io", "button", ...args, "POWER"]);
        break;
      case "rotate": {
        // 翻转当前朝向：先读再设
        const current = await this.client.runJson(["device", "orientation", "get", ...args]);
        const next = current?.orientation === "landscape" ? "portrait" : "landscape";
        await this.client.runJson(["device", "orientation", "set", ...args, next]);
        break;
      }
      default:
        sendJson(res, 400, { ok: false, error: `不支持的动作：${action}` });
        return true;
    }

    sendJson(res, 200, { ok: true, action });
    return true;
  }

  /** 会话状态：面板用它做心跳与错误展示。 */
  async #status(req, res) {
    const devices = await this.client.listDevices({ includeOffline: true });
    const active = devices.find((d) => d.id === this.activeDeviceId) ?? null;
    const session = this.activeDeviceId === null ? null : this.pool.sessions.get(this.activeDeviceId);

    /**
     * adb 健康状态。
     *
     * 只有"一台设备都看不到"时才去查 —— 体检本身要 spawn 一个 adb 进程，
     * 而 #status 是 5 秒一次的心跳，不该每次都付这个代价。设备正常时
     * 直接报 ok，不打扰 adb。
     *
     * 面板据此显示一条可照做的提示，而不是让用户对着空下拉框发呆。
     */
    let adb = { available: true, reason: "ok", hint: "" };
    if (devices.length === 0 && this.adbProbe !== null && this.adbProbe !== undefined) {
      try {
        const probe = await this.adbProbe.get();
        const described = describeAdbProblem(probe);
        adb = {
          available: probe.available,
          reason: probe.reason,
          path: probe.path,
          // 一切正常时不塞多余文案
          message: probe.reason === "ok" ? "" : described.message,
          hint: probe.reason === "ok" ? "" : described.hint,
        };
      } catch (error) {
        this.log("warn", `adb 体检失败：${error?.message ?? error}`);
        adb = { available: true, reason: "unknown", hint: "" };
      }
    }

    sendJson(res, 200, {
      ok: true,
      activeDeviceId: this.activeDeviceId,
      activeDevice: active,
      streaming: session?.running ?? false,
      format: session?.format?.kind ?? "unknown",
      consumerCount: session?.consumers?.size ?? 0,
      devices,
      adb,
    });
    return true;
  }

  // ── 辅助 ────────────────────────────────────────────────────────────

  /**
   * mobilecli 报"没有在线设备"时，查清到底是什么原因。
   *
   * 这是本插件最容易把人带偏的一处：**adb 缺失时 mobilecli 不报错**，
   * 只是安静地返回空列表（实测 exit code 0）。于是"没装 adb"和"没插手机"
   * 长得一模一样。这里用一次 adb 体检把两者分开，并给出各自该做什么。
   *
   * 体检失败不致命：拿不到结论就退回原来那句通用提示，绝不让诊断本身
   * 把一次正常请求变成 500。
   *
   * @returns {Promise<{code: string, message: string, hint: string, adbPath: string|null}>}
   */
  async #diagnoseEmptyDeviceList() {
    const fallback = {
      code: "NO_DEVICE",
      adbPath: null,
      message: "没有在线设备",
      hint: "启动一个模拟器/模拟机，或用 USB 连一台开了调试的手机。",
    };

    if (this.adbProbe === null || this.adbProbe === undefined) return fallback;

    try {
      const probe = await this.adbProbe.get();
      if (probe.reason === "ok") {
        // adb 说设备是好的，但 mobilecli 看不到 —— 这是 daemon 环境过期的
        // 典型症状（daemon 继承的是**启动时**的环境变量）。
        return {
          code: "DEVICE_VISIBLE_TO_ADB_ONLY",
          adbPath: probe.path,
          message: `adb 能看到 ${probe.usable} 台可用设备，但 mobilecli 没看到 —— `
            + "通常是 mobilecli 的常驻 daemon 还在用旧的环境变量。",
          hint: "执行 `mobilecli daemon stop`，然后重新打开面板（daemon 会用当前环境重启）。"
            + "若刚改过 PATH/ANDROID_HOME，还需要重启 DSH 让改动进入进程环境。",
        };
      }
      // 注意：probe.reason === "no-device" 时 mobilecli 也看不到设备，
      // 两者一致 —— 说明确实是没接设备，用原始提示即可
      if (probe.reason === "no-device") return { ...fallback, adbPath: probe.path };

      // 其余（adb-not-found / adb-not-in-env / adb-failed / unauthorized /
      // offline）都各有专属文案，见 describeAdbProblem
      const described = describeAdbProblem(probe);
      return { code: described.code, message: described.message, hint: described.hint, adbPath: described.adbPath };
    } catch (error) {
      this.log("warn", `adb 体检失败（不影响主流程）：${error?.message ?? error}`);
      return fallback;
    }
  }

  /**
   * 当前激活的设备。
   *
   * ⚠️ **热路径，绝不能在这里查设备列表**。
   *
   * 原先每次点击/滑动都调 `listDevices({ includeOffline: true })` 复核设备
   * 还在不在 —— 那是一次完整的设备枚举（spawn mobilecli + daemon IPC +
   * adb 往返），实测 **328ms**，而真正的 `io tap` 只要 133ms。也就是
   * 71% 的点击延迟花在了这个预检查上。用户体感就是"点一下要等 300 多毫秒"。
   *
   * 现在只返回记住的 id，不做存在性复核：
   *   - 设备真掉线时，`mobilecli` 自己会报
   *     `device not found: <id>`（实测），错误信息一样清楚；
   *   - 而"离线"本来就有更权威的信号：状态轮询会更新 devices，
   *     面板据此禁用按钮。
   *
   * 也就是说这个预检查只买到"早 300ms 失败"，代价是让 99% 的正常操作
   * 都慢 300ms —— 明显不划算。
   *
   * @returns {string|null}
   */
  #requireActiveDevice() {
    return this.activeDeviceId;
  }

  /**
   * 从 URL 取 token。
   *
   * 支持两种写法：路径段（/stream/<token>）与查询串（/stream?token=<...>）。
   * 前者更干净，后者便于调试时手动粘贴。
   * @param {import("node:http").IncomingMessage} req
   * @returns {string|undefined}
   */
  #tokenFromUrl(req) {
    const raw = req.url ?? "";
    const queryStart = raw.indexOf("?");
    const pathPart = queryStart === -1 ? raw : raw.slice(0, queryStart);

    const segments = pathPart.split("/").filter((s) => s !== "");
    const last = segments[segments.length - 1];
    if (typeof last === "string" && last !== "" && last !== ROUTES.stream) {
      return decodeURIComponent(last);
    }

    if (queryStart !== -1) {
      const params = new URLSearchParams(raw.slice(queryStart + 1));
      const fromQuery = params.get("token");
      if (fromQuery !== null) return fromQuery;
    }
    return undefined;
  }

  #methodNotAllowed(res, allowed) {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: allowed });
    res.end("method not allowed");
    return true;
  }
}

/**
 * 校验一次交互输入。
 *
 * 坐标必须是有限数字——NaN/字符串会让 mobilecli 拼出畸形参数，
 * 而它的 `optInt` 会把无法解析的值静默变成 0，即"点左上角"。
 * 这个静默行为比报错更糟，所以在 Host 侧就挡掉。
 *
 * @param {string} action
 * @param {any} body
 * @returns {{ok: true, input: any}|{ok: false, error: string}}
 */
export function validateInput(action, body) {
  const finite = (value) => typeof value === "number" && Number.isFinite(value);

  switch (action) {
    case "tap":
      if (!finite(body.x) || !finite(body.y)) {
        return { ok: false, error: "tap 需要数值型 x / y" };
      }
      return { ok: true, input: { action, x: Math.round(body.x), y: Math.round(body.y) } };

    case "longpress":
      if (!finite(body.x) || !finite(body.y)) {
        return { ok: false, error: "longpress 需要数值型 x / y" };
      }
      return {
        ok: true,
        input: {
          action,
          x: Math.round(body.x),
          y: Math.round(body.y),
          duration: finite(body.duration) ? Math.round(body.duration) : undefined,
        },
      };

    case "swipe":
      if (!finite(body.x1) || !finite(body.y1) || !finite(body.x2) || !finite(body.y2)) {
        return { ok: false, error: "swipe 需要数值型 x1 / y1 / x2 / y2" };
      }
      /**
       * `duration` 必须透传下去。
       *
       * mobilecli 不传 `--duration` 时用**平台默认的 1000ms**，实测滑动会
       * 明显"慢动作"（1074ms vs 传 300 时的 374ms）。客户端按手指按住时长
       * 算出一个 duration，Host 侧如果在这里把它丢掉，那个修复就白做了。
       *
       * 这里只做夹取（80–2000ms），防一个畸形值把设备端卡住。
       */
      return {
        ok: true,
        input: {
          action,
          x1: Math.round(body.x1), y1: Math.round(body.y1),
          x2: Math.round(body.x2), y2: Math.round(body.y2),
          ...(finite(body.duration)
            ? { duration: Math.min(2000, Math.max(80, Math.round(body.duration))) }
            : {}),
        },
      };

    case "text":
      if (typeof body.text !== "string" || body.text === "") {
        return { ok: false, error: "text 需要非空字符串" };
      }
      return { ok: true, input: { action, text: body.text } };

    case "keys": {
      /**
       * 键盘按键（物理键盘透传）。
       *
       * ⚠️ 这些字符串**直接进子进程 argv**，而它们源自浏览器事件，
       * 属于不可信输入。必须严格限定形状，否则一个名为 `--device`
       * 或含空格的"按键"就能改变命令语义（甚至注入参数）。
       *
       * 允许的形状（对应的真实按键名实测都可用）：
       *   单键     a  z  0  9  enter  backspace  escape  up  down  left  right
       *            home  end  space  tab  delete  forwarddelete  pageup  pagedown
       *   组合键   shift+a  ctrl+a  cmd+a  alt+tab  ctrl+shift+z
       *
       * 所以规则是：一串 `[a-z0-9]+`，段间用 `+` 连接。`-`、空格、`/` 等
       * 一律不在字符集里，`--device` 这类参数因此天然不可能通过。
       */
      const KEY_TOKEN = /^[a-z0-9]{1,24}(?:\+[a-z0-9]{1,24}){0,3}$/u;
      const MAX_KEYS = 64; // 一次调用的按键上限：面板会合批，但别让它无限大

      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        return { ok: false, error: "keys 需要非空数组" };
      }
      if (body.keys.length > MAX_KEYS) {
        return { ok: false, error: `keys 一次最多 ${MAX_KEYS} 个` };
      }
      const keys = [];
      for (const raw of body.keys) {
        const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
        if (!KEY_TOKEN.test(key)) {
          return { ok: false, error: `非法按键：${String(raw).slice(0, 32)}` };
        }
        keys.push(key);
      }
      return { ok: true, input: { action, keys } };
    }

    case "button": {
      const name = typeof body.name === "string" ? body.name.toUpperCase() : "";
      const allowed = ["HOME", "BACK", "POWER", "VOLUME_UP", "VOLUME_DOWN", "ENTER", "APP_SWITCH"];
      if (!allowed.includes(name)) {
        return { ok: false, error: `button 只支持：${allowed.join(" / ")}` };
      }
      return { ok: true, input: { action, name } };
    }

    default:
      return { ok: false, error: `不支持的 action：${action}` };
  }
}

/**
 * 把路由挂到 DSH 的 webServer 上。
 *
 * DSH 的 register 是「同 (kind, path) 重复注册即抛错」，所以每次挂载都用
 * 独立的子路径；前缀路由只挂一条，内部再分发。
 *
 * @param {object} ctx 插件上下文（需要 ctx.webServer）
 * @param {StreamRoutes} routes
 * @param {string} prefix 形如 /_dsh/dsh-sidebar-mobile
 * @param {Function} [log]
 * @returns {(() => void)|null} disposer；null 表示环境没有 webServer
 */
export function mountRoutes(ctx, routes, prefix, log = () => {}) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    return null;
  }

  const route = {
    kind: "prefix",
    path: prefix,
    handler: async (req, res) => {
      const routeName = matchRouteName(req.url ?? "", prefix);
      if (routeName === null) {
        sendText(res, 404, "not found");
        return;
      }
      const handled = await routes.handle(routeName, req, res);
      if (!handled && !res.headersSent) {
        sendText(res, 404, "not found");
      }
    },
  };

  const registered = webServer.register(route);

  // register 可能返回 disposer、Promise<disposer> 或 undefined（仅写入路由表）。
  // 统一规整成可幂等调用的清理函数。
  if (typeof registered === "function") {
    return () => {
      try {
        registered();
      } catch (error) {
        log("warn", `卸载路由失败：${error?.message ?? error}`);
      }
    };
  }
  if (registered && typeof registered.then === "function") {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      registered
        .then((disposer) => {
          if (typeof disposer === "function") disposer();
        })
        .catch((error) => log("warn", `卸载路由失败：${error?.message ?? error}`));
    };
  }
  return () => {};
}

/**
 * 从请求 URL 匹配出路由名。
 *
 * @param {string} url
 * @param {string} prefix
 * @returns {string|null}
 */
export function matchRouteName(url, prefix) {
  const queryStart = url.indexOf("?");
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  if (!path.startsWith(prefix)) return null;

  const rest = path.slice(prefix.length).replace(/^\/+/, "");
  if (rest === "") return null;

  const first = rest.split("/")[0];
  return Object.values(ROUTES).includes(first) ? first : null;
}
