/**
 * dsh-client-ui-sidebar-mobile — DSH 右侧边栏的移动设备面板。
 *
 * 把 mobilecli 封装成 DSH 的移动设备层：Host 侧管进程/流/工具/技能，
 * Client 侧在右侧边栏渲染实时画面并转发点击。
 *
 * ── 为什么值得单独做一个（而不是直接用现成的设备插件）────────────────
 * 社区已有两个同类插件，各自踩了一个坑：
 *
 *   dsh-android  用 `adb exec-out screencap` 循环取帧，实测 ~1.8fps
 *   dsh-ios      用 serve-sim 的 MJPEG
 *
 * 而 mobilecli 的 AVC 路径在 Android 上实测 104fps、iOS 模拟器 MJPEG 实测
 * 131fps——同一条 API 覆盖两端，且帧率高出两个数量级。更关键的是它能通过
 * Dart VM Service 直读 Flutter 的 render tree（绕过无障碍投影，拿得到
 * widget Key、控件状态、自绘内容），这是现成插件都没有的能力。
 *
 * ── 生命周期 ────────────────────────────────────────────────────────────
 * 所有注册都通过 `ctx.effect`，插件卸载时自动注销：路由、工具、技能、
 * 以及后台的流子进程。disposer 顺序与注册顺序相反，保证先停流再摘路由，
 * 避免摘掉路由后仍有响应在往已卸载的处理器里写。
 *
 * @module dsh-client-ui-sidebar-mobile
 */

import { Mobilecli, resolveBinary } from "./lib/mobilecli.js";
import { registerSkills } from "./lib/skills.js";
import { StreamSessionPool } from "./lib/stream-session.js";
import {
  ROUTES,
  StreamAccessController,
  parseTrustedAuthority,
  prepareStreamAccessKey,
} from "./lib/stream-access.js";
import { StreamRoutes, mountRoutes } from "./lib/stream-routes.js";
import { TOOL_NAMES, createTools } from "./lib/tools.js";

/** Cordis 插件名，也是挂载 id。 */
export const name = "dsh-client-ui-sidebar-mobile";

/**
 * 需要的服务。
 *
 * 只声明 `tools`：它是注册模型工具的前提，缺了插件就没有意义。
 * `webServer` 与 `skills` 用可选注入（见 apply 内部），因为 headless
 * profile 没有它们，但工具本身仍然可用。
 */
export const inject = ["tools"];

/** 默认路由前缀。与 cordis.patch.yml 的 routePrefix 保持一致。 */
const DEFAULT_ROUTE_PREFIX = "/_dsh/dsh-client-ui-sidebar-mobile";

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] 来自 cordis.patch.yml
 */
export function apply(ctx, config = {}) {
  /** @type {Array<() => void>} 逆序执行的清理器 */
  const disposers = [];

  const log = (level, message) => {
    // 日志失败绝不能影响主流程——DSH 会因为未捕获异常隔离整个 profile
    try {
      const logger = ctx.logger;
      if (logger && typeof logger[level] === "function") {
        logger[level](`dsh-client-ui-sidebar-mobile: ${message}`);
      } else if (level === "error" || level === "warn") {
        console.error(`dsh-client-ui-sidebar-mobile: ${message}`);
      }
    } catch {
      // 忽略
    }
  };

  // ── 配置 ────────────────────────────────────────────────────────────

  if (config.enabled === false) {
    log("info", "已通过配置禁用，跳过挂载");
    return;
  }

  const routePrefix =
    typeof config.routePrefix === "string" && config.routePrefix !== ""
      ? config.routePrefix
      : DEFAULT_ROUTE_PREFIX;

  const streamConfig = config.stream ?? {};
  const idleStopMs = secondsToMs(streamConfig.idleStopSeconds, 300);
  const restartDelayMs = toPositiveInt(streamConfig.restartDelayMs, 5_000);

  const trustedAuthorities = [];
  if (Array.isArray(config.trustedAuthorities)) {
    for (const entry of config.trustedAuthorities) {
      const parsed = parseTrustedAuthority(entry);
      if (parsed === null) {
        log("warn", `忽略无法解析的 trustedAuthorities 项：${JSON.stringify(entry)}`);
        continue;
      }
      trustedAuthorities.push(parsed);
    }
  }
  if (trustedAuthorities.length > 0) {
    log("info", `已配置 ${trustedAuthorities.length} 个可信 authority（用于反向代理场景）`);
  }

  // ── 二进制解析 ──────────────────────────────────────────────────────

  const binary = resolveBinary(config.binaryPath);
  if (binary === null) {
    // 解析不到不是致命错误：工具仍注册，调用时给出可读的安装提示。
    // 这样用户能看到"装 mobilecli"而不是插件加载失败的栈回溯。
    log(
      "warn",
      "找不到 mobilecli 二进制。装上它即可启用：npm i -g mobilecli@latest"
        + "（或用 MOBILECLI_PATH / 配置里的 binaryPath 指定路径）",
    );
  } else {
    log("info", `使用 mobilecli：${binary}`);
  }

  const client = new Mobilecli({
    binary: binary ?? "mobilecli", // 解析失败时留个占位，调用会抛出可读错误
    home: typeof config.homeDir === "string" && config.homeDir !== "" ? config.homeDir : null,
    log,
  });

  /** 二进制缺失时统一给出安装指引，而不是让 execFile 抛 ENOENT。 */
  const ensureBinary = () => {
    if (binary === null) {
      throw new Error(
        "mobilecli 不可用。安装：npm i -g mobilecli@latest"
          + "，或用 MOBILECLI_PATH 环境变量 / cordis.patch.yml 里的 binaryPath 指定路径。",
      );
    }
  };

  // 把 client.runJson 包一层：每次调用前确认二进制存在
  const guardedClient = {
    ...client,
    runJson: (args, options) => {
      ensureBinary();
      return client.runJson(args, options);
    },
    listDevices: (options) => {
      ensureBinary();
      return client.listDevices(options);
    },
    daemonStatus: () => client.daemonStatus(), // 诊断接口不拦
  };

  // ── 流会话池 ────────────────────────────────────────────────────────

  const pool = new StreamSessionPool({
    idleStopMs,
    restartDelayMs,
    log,
    spawnFor: (deviceId) => {
      ensureBinary();
      // 格式交给 mobilecli 决定：Android 上 AVC 更快，iOS 模拟器上它会给
      // MJPEG（实测 --format avc 会被静默降级）。Host 侧从字节嗅探真实格式，
      // 所以这里无需分支。
      const args = ["screencapture", "--device", deviceId, "--format", "avc"];
      const scale = streamConfig.defaultScale;
      if (typeof scale === "number" && scale > 0 && scale !== 1) {
        args.push("--scale", String(scale));
      }
      log("info", `启动流：${deviceId}`);
      return client.spawnStream(args);
    },
  });

  // ── 路由 ────────────────────────────────────────────────────────────

  const access = new StreamAccessController({ key: prepareStreamAccessKey() });
  const routes = new StreamRoutes({
    client: guardedClient,
    pool,
    access,
    trustedAuthorities,
    log,
  });

  // webServer 是可选服务：headless profile 没有它，此时面板不可用但工具照常。
  //
  // ⚠️ ctx.inject 的返回值形状随 DSH 版本变化：dsh-android 的注释指出它返回的是
  // 作用域 fiber（要调 fiber.dispose() 才拆），但这不保证所有版本都有 dispose。
  // 所以这里既不假设它有 dispose，也不把「没有」当成错误——路由的清理其实由
  // 上面那个 wsCtx.effect(...) 里的 disposer 负责，fiber 只是兜底。
  const webServerInjection = ctx.inject(["webServer"], (wsCtx) => {
    const cleanup = mountRoutes(wsCtx, routes, routePrefix, log);
    if (cleanup === null) {
      log("warn", "webServer 没有 register 接口，侧边栏面板不可用（工具仍可用）");
      return;
    }
    wsCtx.effect(() => cleanup, "dsh-client-ui-sidebar-mobile:routes");
    log("info", `流路由已挂载：${routePrefix}/{${Object.values(ROUTES).join(",")}}`);
  });
  disposers.push(() => {
    if (webServerInjection !== null && typeof webServerInjection?.dispose === "function") {
      webServerInjection.dispose();
    }
  });

  // ── 模型工具 ────────────────────────────────────────────────────────

  const tools = createTools({
    client: guardedClient,
    // 工具的 streaming 状态与面板共用同一个会话池，两端看到的是一致的
    acquireSession: (deviceId) => pool.acquire(deviceId),
  });

  for (const [toolName, definition] of Object.entries(tools)) {
    disposers.push(
      ctx.effect(
        () => ctx.tools.register(definition),
        `dsh-client-ui-sidebar-mobile:tool:${toolName}`,
      ),
    );
  }
  log("info", `已注册 ${Object.keys(tools).length} 个工具`);

  // ── 技能 ────────────────────────────────────────────────────────────

  if (config.registerSkills !== false) {
    disposers.push(registerSkills(ctx, log));
  }

  // ── 清理 ────────────────────────────────────────────────────────────
  //
  // 逆序执行：先注销工具/技能，再摘路由，最后停流进程。
  // 这样不会出现"路由还在但处理器已经没了"的窗口。
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        log("warn", `清理失败：${error?.message ?? error}`);
      }
    }
    // 停掉所有流子进程。放着不管会让设备一直编码（耗电、占 USB 带宽）。
    try {
      pool.stopAll();
    } catch (error) {
      log("warn", `停止流失败：${error?.message ?? error}`);
    }
    log("info", "已卸载");
  }, "dsh-client-ui-sidebar-mobile:teardown");
}

/**
 * 秒 → 毫秒，带默认值与下限。
 * @param {unknown} seconds
 * @param {number} fallbackSeconds
 * @returns {number}
 */
function secondsToMs(seconds, fallbackSeconds) {
  const value = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : fallbackSeconds;
  return value * 1000;
}

/**
 * 取正整数，非法值回落到默认。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

// 供测试与外部引用
export { TOOL_NAMES, resolveBinary };
