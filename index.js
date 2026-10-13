/**
 * dsh-sidebar-mobile — DSH 右侧边栏的移动设备面板。
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
 * @module dsh-sidebar-mobile
 */

import { Mobilecli, resolveBinary } from "./lib/device/mobilecli.js";
import { AdbProbe, findAdb } from "./lib/device/android-toolchain.js";
import { registerSkills } from "./lib/agent/skills.js";
import { StreamSessionPool } from "./lib/stream/session.js";
import {
  ROUTES,
  StreamAccessController,
  parseTrustedAuthority,
  prepareStreamAccessKey,
} from "./lib/stream/access.js";
import { StreamRoutes, mountRoutes } from "./lib/stream/routes.js";
import { DaemonRpc } from "./lib/device/daemon-rpc.js";
import { TOOL_NAMES, createTools } from "./lib/agent/tools.js";

/** Cordis 插件名，也是挂载 id。 */
export const name = "dsh-sidebar-mobile";

/**
 * 需要的服务。
 *
 * 只声明 `tools`：它是注册模型工具的前提，缺了插件就没有意义。
 * `webServer` 与 `skills` 用可选注入（见 apply 内部），因为 headless
 * profile 没有它们，但工具本身仍然可用。
 */
export const inject = ["tools"];

/** 默认路由前缀。与 cordis.patch.yml 的 routePrefix 保持一致。 */
const DEFAULT_ROUTE_PREFIX = "/_dsh/dsh-sidebar-mobile";

/**
 * AVC 默认码率（bps）。
 *
 * mobilecli 的 `--bitrate` 默认值很低，实测 1080×2400 静止仅 0.98 Mbps。
 * 8 Mbps 是 1080p 实时画面的常见取值，远低于 USB 实际吞吐。
 * mobilecli 允许的范围是 100000–10000000。
 */
const DEFAULT_BITRATE_BPS = 8_000_000;

/**
 * 默认帧率上限。
 *
 * 不设限时实测会冲到 88fps（滑动中），远超需要，并把解码队列拖垮。
 * 30fps 足够镜像操作，且能同时缓解延迟累积与主线程卡顿。
 */
const DEFAULT_MAX_FPS = 30;

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
        logger[level](`dsh-sidebar-mobile: ${message}`);
      } else if (level === "error" || level === "warn") {
        console.error(`dsh-sidebar-mobile: ${message}`);
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

  /**
   * MOBILECLI_HOME。**必须让 CLI 与 RPC 用同一个值** —— 否则两边会连到
   * 不同的 daemon（socket 路径是 `<home>/daemon.sock`），表现为 RPC 报
   * 连不上而 CLI 正常，或反过来。
   */
  const mobilecliHome = typeof config.homeDir === "string" && config.homeDir !== "" ? config.homeDir : null;

  const client = new Mobilecli({
    binary: binary ?? "mobilecli", // 解析失败时留个占位，调用会抛出可读错误
    home: mobilecliHome,
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
  //
  // ⚠️ 不用 `{...client}` 展开。class 的方法在原型上、私有字段（#deviceCache）
  // 不在自有属性里，展开都拿不到 —— 展开出来的对象看着像 client，实际只有
  // 几个数据字段。这里显式列出要转发的方法，语义清楚也不会悄悄漏掉。
  const guardedClient = {
    runJson: (args, options) => {
      ensureBinary();
      return client.runJson(args, options);
    },
    listDevices: (options) => {
      ensureBinary();
      return client.listDevices(options);
    },
    /** 设备缓存失效：切换设备、设备动作后调用，避免读到过期列表。 */
    invalidateDevices: () => client.invalidateDevices(),
    daemonStatus: () => client.daemonStatus(), // 诊断接口不拦
  };

  // ── Android 工具链（adb）体检 ────────────────────────────────────────
  //
  // ⚠️ 这一步是必需的，不是锦上添花。mobilecli 不自己实现 adb 协议，它调外部
  // adb；而 adb 缺失时它的行为是**静默降级**，不是报错：
  //
  //     实测 mobilecli 1.0.19（手机已连、驱动正常、仅缺 adb）：
  //       devices  →  {"status":"ok","data":{"devices":[]}}    exit code 0
  //
  // 返回值完全正常，只是列表是空的。于是插件会把"没装 adb"报告成
  // "没有在线设备"，把用户指向换数据线/翻开发者选项 —— 全是错的方向。
  //
  // 所以启动时先体检一次 adb 并在日志里讲清楚；路由侧还会在"空设备列表"
  // 时再查一次（用 AdbProbe 的缓存，不会重复 spawn）。
  const adbProbe = new AdbProbe({ log });

  void adbProbe
    .get()
    .then((probe) => {
      if (probe.reason === "ok") {
        log("info", `adb 就绪：${probe.path}（${probe.usable} 台可用设备）`);
        return;
      }
      if (probe.available) {
        log("info", `adb 已找到：${probe.path}（${probe.reason}）`);
      } else {
        log("warn", `未找到 adb（Android 设备将无法被发现）：${findAdb() ?? "不在 PATH / ANDROID_HOME 下"}`);
        log("warn", "装上 platform-tools 并把 adb 放进 PATH（或设 ANDROID_HOME），然后重启 DSH");
      }
    })
    .catch((error) => {
      log("warn", `adb 体检失败（不影响加载）：${error?.message ?? error}`);
    });

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

      /**
       * ⚠️ 码率必须显式指定。
       *
       * mobilecli 不传 `--bitrate` 时的默认值很低：实测 1080×2400 的
       * Xiaomi 15 Pro，静止 0.98 Mbps、滑动 2.15 Mbps。而同一台设备传
       * `--bitrate 8000000` 后滑动能到 4.88 Mbps —— 这就是"画面糊"的主因
       * （大范围运动时码率不够，编码器只能糊掉细节）。
       *
       * 1080p 级别的实时画面给 8 Mbps 是常见取值，也远低于 USB/adb 的
       * 实际吞吐（实测 adb 上跑 5 Mbps 毫无压力）。
       */
      const bitrate = toPositiveInt(streamConfig.bitrate, DEFAULT_BITRATE_BPS);
      args.push("--bitrate", String(bitrate));

      /**
       * ⚠️ `--fps` 实测**无效**，但仍然传。
       *
       * 复测（Xiaomi 15 Pro / 1080×2400 / mobilecli 1.0.19）：
       *
       *     不传 --fps   → 120.6 fps
       *     --fps 30     → 105.5 fps
       *     --fps 15     → 100.7 fps
       *
       * 传什么都是 ~120fps，所以**限流不能指望这个参数**。真正起作用的是
       * 客户端渲染侧：每帧都解码（保住 H.264 参考链，不花屏），但只按
       * 30fps 绘制（见 client.js 的 TARGET_RENDER_FPS）。
       *
       * 这里仍然传上去有两个理由：① 上游哪天修好了就自动生效；
       * ② 它出现在命令行里，排查时一眼能看到我们期望的帧率。
       */
      const fps = toPositiveInt(streamConfig.maxFps, DEFAULT_MAX_FPS);
      args.push("--fps", String(fps));

      const scale = streamConfig.defaultScale;
      if (typeof scale === "number" && scale > 0 && scale !== 1) {
        args.push("--scale", String(scale));
      }
      log("info", `启动流：${deviceId}（${bitrate / 1e6}Mbps / ${fps}fps）`);
      return client.spawnStream(args);
    },
  });

  // ── 路由 ────────────────────────────────────────────────────────────

  const access = new StreamAccessController({ key: prepareStreamAccessKey() });
  /**
   * 交互指令的加速通道。
   *
   * daemon 的 unix socket 直接吃 JSON-RPC，而 daemon 本来就在运行
   * （CLI 每条命令都会把它拉起来）—— 所以这条路径**不需要新起进程、
   * 不需要端口、没有会话过期**，却省掉每条命令约 66ms 的 node 进程启动。
   * 实测 `device.io.tap` 7.3ms vs CLI 104.2ms。
   *
   * 配置 `useDaemonRpc: false` 可强制走 CLI（排查时用）。
   */
  const rpc = config.useDaemonRpc === false
    ? null
    : new DaemonRpc({ home: mobilecliHome, log });
  log(
    "info",
    rpc === null
      ? "交互指令走 CLI（daemon RPC 已按配置禁用）"
      : `交互指令优先走 daemon RPC：${rpc.socketPath}`,
  );

  const routes = new StreamRoutes({
    client: guardedClient,
    pool,
    access,
    trustedAuthorities,
    adbProbe,
    log,
    rpc,
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
    wsCtx.effect(() => cleanup, "dsh-sidebar-mobile:routes");
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
    /**
     * `mobile_open_panel` 的实现：请求浏览器把侧边栏面板打开，并等回执。
     *
     * 跨进程的活由 routes 那边做（客户端长轮询 + 回执），这里只是把能力
     * 交给工具。routes 在没挂上 webServer 时仍然是可用对象，但没人会来
     * 轮询 —— 那种情况工具会如实回 opened:false。
     */
    openPanel: () => routes.requestPanelOpen(),
  });

  for (const [toolName, definition] of Object.entries(tools)) {
    disposers.push(
      ctx.effect(
        () => ctx.tools.register(definition),
        `dsh-sidebar-mobile:tool:${toolName}`,
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
  }, "dsh-sidebar-mobile:teardown");
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
