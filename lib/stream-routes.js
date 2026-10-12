/**
 * 流路由：把 mobilecli 的画面与控制经 DSH 自己的 web 源暴露给面板。
 *
 * 所有路由挂在 `/_dsh/dsh-client-ui-sidebar-mobile/*` 前缀下，浏览器只用
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
 * @module dsh-client-ui-sidebar-mobile/lib/stream-routes
 */

import {
  ROUTES,
  checkTransportFence,
  isSameOriginRequest,
} from "./stream-access.js";

/** POST body 上限。控制指令都是小 JSON，64KB 绰绰有余。 */
const MAX_BODY_BYTES = 64 * 1024;

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
  /** @type {import("./stream-session.js").StreamSession|null} */
  let sub = null;

  const cleanup = () => {
    if (sub !== null) {
      sub.remove();
      sub = null;
    }
  };

  // 等首块，拿到格式后再写响应头
  const first = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, firstByteTimeoutMs);

    sub = session.addConsumer((chunk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(chunk);
    });

    // 客户端在首块到达前就断开（用户关面板）
    res.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (first === null) {
    cleanup();
    if (!res.headersSent) {
      sendText(res, 504, "device stream did not produce a first frame in time");
    } else {
      res.end();
    }
    return;
  }

  const format = session.format;
  if (!res.headersSent) {
    res.writeHead(200, {
      ...STREAM_HEADERS,
      "content-type": format.contentType ?? "application/octet-stream",
    });
  }
  res.write(first);

  // 首块之后的字节直接透传
  let closed = false;
  res.on("close", () => {
    closed = true;
    cleanup();
  });

  const sub2 = session.addConsumer((chunk) => {
    if (closed) return;
    // 背压：写缓冲积压时丢帧而不是无限堆积内存。
    // 视频流丢帧是可接受的，卡死整个 Host 不是。
    if (res.writableLength > 4 * 1024 * 1024) return;
    try {
      res.write(chunk);
    } catch {
      closed = true;
      cleanup();
    }
  });
  sub = sub2;
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
   * @param {Function} [options.log]
   */
  constructor({ client, pool, access, trustedAuthorities = [], log = () => {} }) {
    this.client = client;
    this.pool = pool;
    this.access = access;
    this.trustedAuthorities = trustedAuthorities;
    this.log = log;
    /** 当前面板正在看的设备。null 表示还没选。 */
    this.activeDeviceId = null;
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
    const devices = await this.client.listDevices();
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
      sendJson(res, 409, {
        ok: false,
        error: "没有在线设备",
        hint: "启动一个模拟器/模拟机，或用 USB 连一台开了调试的手机。",
        devices,
      });
      return true;
    }

    // 切换设备时停掉上一条流，避免同时在编两路
    if (this.activeDeviceId !== null && this.activeDeviceId !== deviceId) {
      this.pool.stop(this.activeDeviceId);
    }
    this.activeDeviceId = deviceId;

    const device = devices.find((d) => d.id === deviceId);
    sendJson(res, 200, {
      ok: true,
      device,
      devices,
      streamToken: this.access.mint(deviceId),
      expiresInMs: this.access.ttlMs,
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

    const deviceId = await this.#requireActiveDevice();
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
    await session.sendInput(
      (args) => this.client.runJson(args, { timeoutMs: 20_000 }),
      validation.input,
    );
    sendJson(res, 200, { ok: true, action });
    return true;
  }

  /** 设备级动作：home / back / 旋转。 */
  async #deviceAction(req, res) {
    if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");

    const deviceId = await this.#requireActiveDevice();
    if (deviceId === null) {
      sendJson(res, 409, { ok: false, error: "尚未选择设备" });
      return true;
    }

    const body = await readJsonBody(req);
    const action = typeof body.action === "string" ? body.action : "";
    const args = ["--device", deviceId];

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
    sendJson(res, 200, {
      ok: true,
      activeDeviceId: this.activeDeviceId,
      activeDevice: active,
      streaming: session?.running ?? false,
      format: session?.format?.kind ?? "unknown",
      consumerCount: session?.consumers?.size ?? 0,
      devices,
    });
    return true;
  }

  // ── 辅助 ────────────────────────────────────────────────────────────

  /**
   * 当前激活的设备。若它已离线则返回 null。
   * @returns {Promise<string|null>}
   */
  async #requireActiveDevice() {
    if (this.activeDeviceId === null) return null;
    const devices = await this.client.listDevices({ includeOffline: true });
    const found = devices.find((d) => d.id === this.activeDeviceId);
    if (found === undefined) return null;
    return found.id;
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
      return {
        ok: true,
        input: {
          action,
          x1: Math.round(body.x1), y1: Math.round(body.y1),
          x2: Math.round(body.x2), y2: Math.round(body.y2),
        },
      };

    case "text":
      if (typeof body.text !== "string" || body.text === "") {
        return { ok: false, error: "text 需要非空字符串" };
      }
      return { ok: true, input: { action, text: body.text } };

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
 * @param {string} prefix 形如 /_dsh/dsh-client-ui-sidebar-mobile
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
