/**
 * 流访问控制：签名 capability + loopback 围栏。
 *
 * ── 为什么要中间层而不是让浏览器直连 mobilecli ────────────────────────
 * mobilecli 的 server 监听在 localhost:12000，没有任何鉴权。若把它的端口
 * 直接暴露给页面，任何能访问该端口的本机进程都能操控你的手机；更糟的是，
 * 若 DSH 本身经反向代理对外（dsh-pocket 就是这么用的），远端也能打到它。
 *
 * 所以本插件让**浏览器的每一个字节都只经过 DSH 自己的 web 源**：
 *
 *     <img src="/_dsh/dsh-sidebar-mobile/stream/<token>">
 *          → 本模块校验 → Host 去连 mobilecli → 转发
 *
 * 浏览器从不接触 mobilecli 的端口，也就没有第二个攻击面。
 *
 * ── 两道闸门，顺序不能反 ──────────────────────────────────────────────
 *   ① 传输层围栏（先）：请求必须来自 loopback，Host 头必须是 loopback 或
 *      显式配置的 authority。这一层**不信任任何客户端可控数据**——
 *      尤其是 Host 与 Origin，它们只用来否决，不用来授权。
 *   ② capability（后）：HMAC-SHA256 签名的短时令牌，10 分钟过期。
 *      签给一个设备的令牌，切到另一个设备立刻失效。
 *
 * 为什么不只用 token：token 会出现在 URL 里，会被浏览器历史、日志、
 * Referer 记录。围栏先挡住「根本不是本机来的」请求，token 才有意义。
 *
 * @module dsh-sidebar-mobile/lib/stream-access
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** capability 的有效期。够打开面板、切几次设备，短到泄漏了也没多大用。 */
export const TOKEN_TTL_MS = 10 * 60 * 1000;

/** 各路由在插件前缀下的相对路径。 */
export const ROUTES = {
  /** 用 token 取流（MJPEG 或 H.264）。 */
  stream: "stream",
  /** 用 token 取一张截图（面板首帧、卡片缩略图）。 */
  screenshot: "screenshot",
  /** 申请 token + 拿当前会话状态（POST）。 */
  grant: "grant",
  /** 设备列表（POST，需要 Origin 校验）。 */
  devices: "devices",
  /** 切换当前设备（POST）。 */
  switchDevice: "switch-device",
  /** 把面板上的点击/滑动转发到设备（POST）。 */
  control: "control",
  /** 设备级动作：home / back / 旋转 / 亮屏（POST）。 */
  deviceAction: "device-action",
  /** 会话状态，给面板做心跳与错误展示。 */
  status: "status",
};

/**
 * 取插件状态目录。跟随 DSH_HOME，与其它 DSH 运行产物放在一起。
 * @returns {string}
 */
export function stateRoot() {
  const dshHome = process.env.DSH_HOME;
  const base = typeof dshHome === "string" && dshHome !== "" ? dshHome : join(homedir(), ".dsh");
  return join(base, "cache", "dsh-sidebar-mobile");
}

/**
 * 读取（或首次生成）签名密钥。
 *
 * 每个 DSH_HOME 一把，0600。之所以落在磁盘而不是每次进程启动随机生成：
 * 页面刷新、Host 热重载都不应该让已发出的 token 全部失效——那会让面板
 * 出现难以解释的 401。
 *
 * @returns {Buffer}
 */
export function prepareStreamAccessKey() {
  const dir = stateRoot();
  const keyPath = join(dir, "stream-access.key");

  try {
    const existing = readFileSync(keyPath);
    if (existing.length === 32) return existing;
  } catch {
    // 不存在或读不了 —— 走生成分支
  }

  const key = randomBytes(32);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // wx：并发生成时只有一个能赢，输的那个读回来即可，不覆盖别人的密钥
    writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // 某些文件系统不支持 chmod；权限已在 create 时给过
    }
    return key;
  } catch {
    try {
      return readFileSync(keyPath);
    } catch {
      // 落盘彻底失败（只读 HOME）——退化成本次进程内的密钥，
      // 面板在本次运行内仍可用，只是重启后旧 token 失效
      return key;
    }
  }
}

/**
 * 判断对端地址是否 loopback。
 *
 * 同时接受 IPv4 / IPv6 与 IPv4-mapped 形式：Node 在不同监听配置下会把
 * `::ffff:127.0.0.1` 也报成 loopback，漏判会把本机请求误伤成 403。
 *
 * @param {string|undefined} address
 * @returns {boolean}
 */
export function isLoopbackRemoteAddress(address) {
  if (typeof address !== "string" || address === "") return false;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  // IPv4-mapped IPv6
  if (address.startsWith("::ffff:")) {
    const v4 = address.slice("::ffff:".length);
    return v4 === "127.0.0.1" || v4.startsWith("127.");
  }
  return false;
}

/**
 * 解析一条 trustedAuthorities 配置项。
 *
 * 与 dsh-android 保持同一套语义，让用户在两处看到一致的写法：
 *   host                  → 该主机名，任意 Host 端口
 *   host:port             → 精确匹配 host:port
 *   https://host:port     → 同时钉住 scheme
 *
 * @param {string} entry
 * @returns {{host: string, port: number|null, scheme: string|null}|null}
 */
export function parseTrustedAuthority(entry) {
  if (typeof entry !== "string" || entry.trim() === "") return null;
  let rest = entry.trim();
  let scheme = null;

  const schemeMatch = /^(https?):\/\//.exec(rest);
  if (schemeMatch !== null) {
    scheme = schemeMatch[1];
    rest = rest.slice(schemeMatch[0].length);
  }
  // 拒绝带路径/查询/凭证的写法：authority 就是 authority
  if (rest.includes("/") || rest.includes("?") || rest.includes("#") || rest.includes("@")) {
    return null;
  }

  const lastColon = rest.lastIndexOf(":");
  if (lastColon > 0) {
    const portPart = rest.slice(lastColon + 1);
    const port = Number.parseInt(portPart, 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return { host: rest.slice(0, lastColon).toLowerCase(), port, scheme };
    }
  }
  return { host: rest.toLowerCase(), port: null, scheme };
}

/**
 * 请求是否通过传输层围栏。
 *
 * ⚠️ Host 与 Origin 是客户端可控数据。这里只用它们**否决**请求：
 * 一个伪造 Host 的请求会被挡下，而它从来不足以让请求通过——
 * 对端地址必须是 loopback，那是 TCP 层的事实，伪造不了。
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {{host: string, port: number|null, scheme: string|null}[]} trusted
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkTransportFence(req, trusted = []) {
  const remote = req.socket?.remoteAddress;
  if (!isLoopbackRemoteAddress(remote)) {
    return { ok: false, reason: `non-loopback peer: ${remote ?? "unknown"}` };
  }

  const hostHeader = typeof req.headers?.host === "string" ? req.headers.host : "";
  if (hostHeader === "") {
    return { ok: false, reason: "missing Host header" };
  }

  // 本机 Host 直接放行（含 localhost / 127.0.0.1 / [::1]，端口任意）
  if (isLoopbackHostHeader(hostHeader)) return { ok: true };

  // 其余必须显式列进 trustedAuthorities
  const parsed = parseAuthorityFromHeader(hostHeader);
  if (parsed === null) {
    return { ok: false, reason: `unparseable Host: ${hostHeader}` };
  }

  for (const entry of trusted) {
    if (entry.host !== parsed.host) continue;
    if (entry.port !== null && entry.port !== parsed.port) continue;
    if (entry.scheme !== null) {
      const origin = req.headers?.origin;
      // 有 Origin 时 scheme 必须对得上；没有 Origin（如 <img> 导航）则不追究
      if (typeof origin === "string" && origin !== "") {
        const originScheme = /^(https?):\/\//.exec(origin)?.[1] ?? null;
        if (originScheme !== entry.scheme) continue;
      }
    }
    return { ok: true };
  }

  return { ok: false, reason: `Host not trusted: ${hostHeader}` };
}

/**
 * Host 头是否是 loopback authority。
 * @param {string} hostHeader
 * @returns {boolean}
 */
function isLoopbackHostHeader(hostHeader) {
  const parsed = parseAuthorityFromHeader(hostHeader);
  if (parsed === null) return false;
  return (
    parsed.host === "localhost" ||
    parsed.host === "127.0.0.1" ||
    parsed.host === "[::1]" ||
    parsed.host === "::1" ||
    parsed.host.startsWith("127.")
  );
}

/**
 * 从 Host 头拆出 host 与 port（port 缺省时按 scheme 推断 80/443 的调用方约定填 0）。
 * @param {string} value
 * @returns {{host: string, port: number}|null}
 */
function parseAuthorityFromHeader(value) {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // [::1]:8080
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1) return null;
    const host = trimmed.slice(0, close + 1).toLowerCase();
    const rest = trimmed.slice(close + 1);
    if (rest === "") return { host, port: 0 };
    if (!rest.startsWith(":")) return null;
    const port = Number.parseInt(rest.slice(1), 10);
    return Number.isInteger(port) ? { host, port } : null;
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { host: trimmed.toLowerCase(), port: 0 };
  const port = Number.parseInt(trimmed.slice(lastColon + 1), 10);
  if (!Number.isInteger(port)) return { host: trimmed.toLowerCase(), port: 0 };
  return { host: trimmed.slice(0, lastColon).toLowerCase(), port };
}

/**
 * 判断 POST 请求是否同源。
 *
 * GET 的流/截图路由不做 Origin 校验（`<img>` 导航不带 Origin），
 * 但所有会改变状态或消耗设备的 POST 都必须过这一关：
 * Origin 是浏览器提供的保护，能挡住其它站点发起的跨站请求。
 * ⚠️ 它不是鉴权——非浏览器客户端可以伪造，所以它只作为围栏的补充。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
export function isSameOriginRequest(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== "string" || origin === "") {
    // 非浏览器客户端（curl / 测试）不带 Origin。此时靠 loopback 围栏兜底。
    return true;
  }
  const host = req.headers?.host;
  if (typeof host !== "string" || host === "") return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * capability 的签发与校验。
 *
 * 载荷格式：`<deviceId>.<expiresAtMs>`，签名是对整个载荷的 HMAC。
 * deviceId 参与签名，所以给 A 设备签的令牌拿到 B 设备上用不了。
 */
export class StreamAccessController {
  /**
   * @param {object} options
   * @param {Buffer} options.key HMAC 密钥
   * @param {number} [options.ttlMs]
   */
  constructor({ key, ttlMs = TOKEN_TTL_MS }) {
    this.key = key;
    this.ttlMs = ttlMs;
  }

  /**
   * 为一个设备签发 capability。
   * @param {string} deviceId
   * @returns {string} base64url(payload).base64url(mac)
   */
  mint(deviceId) {
    const payload = `${deviceId}.${Date.now() + this.ttlMs}`;
    const mac = createHmac("sha256", this.key).update(payload).digest("base64url");
    return `${Buffer.from(payload, "utf8").toString("base64url")}.${mac}`;
  }

  /**
   * 校验 capability，并返回它绑定的设备。
   *
   * 用 timingSafeEqual 比较签名：长度不等时它自己会抛，所以先比长度。
   *
   * @param {string|undefined} token
   * @returns {{ok: true, deviceId: string, expiresAt: number}|{ok: false, reason: string}}
   */
  verify(token) {
    if (typeof token !== "string" || token === "") {
      return { ok: false, reason: "missing token" };
    }
    const dot = token.indexOf(".");
    if (dot === -1) return { ok: false, reason: "malformed token" };

    const payloadB64 = token.slice(0, dot);
    const providedMac = token.slice(dot + 1);

    let payload;
    try {
      payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    } catch {
      return { ok: false, reason: "malformed payload" };
    }

    const expectedMac = createHmac("sha256", this.key).update(payload).digest("base64url");
    const a = Buffer.from(providedMac, "utf8");
    const b = Buffer.from(expectedMac, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad signature" };
    }

    // deviceId 里不含 "."，所以从最后一个 "." 处切分
    const sep = payload.lastIndexOf(".");
    if (sep === -1) return { ok: false, reason: "malformed payload" };
    const deviceId = payload.slice(0, sep);
    const expiresAt = Number.parseInt(payload.slice(sep + 1), 10);

    if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed expiry" };
    if (Date.now() > expiresAt) return { ok: false, reason: "token expired" };
    if (deviceId === "") return { ok: false, reason: "empty device id" };

    return { ok: true, deviceId, expiresAt };
  }
}
