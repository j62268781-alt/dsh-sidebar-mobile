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
import { exactScale, MIN_SCALE } from "./lib/stream/scale-plan.js";
import {
  ROUTES,
  StreamAccessController,
  parseTrustedAuthority,
  prepareStreamAccessKey,
} from "./lib/stream/access.js";
import { StreamRoutes, mountRoutes } from "./lib/stream/routes.js";
import { DaemonRpc, isSafeCliFallbackError, rpcForInput } from "./lib/device/daemon-rpc.js";
import { MOBILE_LOOP_PURPOSE, MOBILE_LOOP_TOOL_NAME } from "./lib/agent/mobile-loop.js";
import { TOOL_NAMES, createMobileLoopTool, createTools } from "./lib/agent/tools.js";

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
 * 码率上限（bps）。mobilecli 允许的范围是 100000–10000000，这里取到顶。
 *
 * mobilecli 的 `--bitrate` 默认值很低（实测 1080×2400 静止仅 0.98 Mbps），
 * 所以必须显式给。给多少？实测（一加12 / 1080×2376 / 连续横滑 6 秒）：
 *
 *     8 Mbps  → 实测 7.10 Mbps（= 上限的 89%，基本打满）
 *     10 Mbps → 实测 8.72 Mbps（比特数比 8 Mbps 多 23%，帧更大、细节更多）
 *
 * 也就是**原来那个 8 Mbps 对 1080p 是不够用的**：运动时编码器一直贴着上限跑，
 * 只能靠糊掉细节来满足约束。USB/adb 侧远未饱和（普通 USB2 实测也能跑 20+
 * Mbps），所以这里直接取 mobilecli 允许的最大值。
 *
 * ⚠️ 该上限是**软**的：设 4 Mbps 实测也能跑到 6.79 Mbps（内容复杂时编码器
 * 会超过设定值），所以不要拿它当硬限流用。
 */
const MAX_BITRATE_BPS = 10_000_000;

/**
 * 取流分辨率缩放下限（与 lib/stream/scale-plan.js 共用同一个常量）。
 *
 * 面板是侧边栏，宽度通常 300–400 CSS px，物理像素（DPR 2）也就 700 上下。
 * 再往下缩虽然更省，但 1080 宽的手机缩到 0.35（378 px）后文字笔画会糊，
 * 反而伤清晰度。0.35 是"再小就没意义"的下限，不是推荐值。
 */
const MIN_STREAM_SCALE = MIN_SCALE;

/**
 * 缩放到这个值以上就当作不缩放。
 *
 * 0.97 与 1.0 的像素差（1080 → 1048）肉眼看不出，但会让 `--scale` 参数
 * 一直存在、让"取的流尺寸 == 设备尺寸"这个前提失效（坐标换算、诊断都变复杂）。
 */
const SCALE_SNAP_THRESHOLD = 0.97;

/**
 * 计算某个 scale 下该给多少码率。
 *
 * 分辨率降下来之后码率不该还是 1080p 的数：像素少了 2.25 倍，同样码率意味着
 * 每像素比特多 2.25 倍，超出编码器收益区间；而帧变小、缓冲更浅，端到端延迟
 * 反而更低（背压阈值是**字节**数，10 Mbps 的流只需要 200ms 就能填满 256KB）。
 *
 * 但也不按 scale² 一路缩到底：缩放后浏览器不再做降采样（画布 1:1 映射到
 * 物理像素），同样的每像素比特在这里的视觉收益比"1080p 缩到 700px"更高，
 * 所以留 0.5 的下限，即最少给到 5 Mbps。
 *
 * @param {number} scale
 * @returns {number} bps
 */
function bitrateForScale(scale) {
  const factor = Math.max(scale * scale, 0.5);
  const raw = Math.round(MAX_BITRATE_BPS * factor);
  // 取整到 0.5 Mbps，日志里好读，也避免每次 scale 微调都换一个怪数字
  return Math.round(raw / 500_000) * 500_000;
}

/**
 * 把外部传入的 scale 规整成可用值。
 *
 * 非法/缺失一律返回 null 交给调用方回落默认，避免用一个 NaN 去算码率和坐标。
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeScale(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const clamped = Math.min(1, Math.max(MIN_STREAM_SCALE, value));
  if (clamped >= SCALE_SNAP_THRESHOLD) return 1;
  // 5 位小数不是"精度洁癖"：精确命中画布要求 `deviceWidth × scale` 四舍五入回画布宽，
  // 1080 宽的手机保留 3 位小数会带来最多 0.54px 的偏差 —— 而实测（同图走 canvas）
  // 1.01× 的重采样就把边缘能量从 0.967 打到 0.854，所以这里不能自己丢精度。
  return Number(clamped.toFixed(5));
}

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
    spawnFor: (deviceId, options) => {
      ensureBinary();
      // 格式交给 mobilecli 决定：Android 上 AVC 更快，iOS 模拟器上它会给
      // MJPEG（实测 --format avc 会被静默降级）。Host 侧从字节嗅探真实格式，
      // 所以这里无需分支。
      const args = ["screencapture", "--device", deviceId, "--format", "avc"];

      /**
       * 分辨率：默认不缩（= 设备原始分辨率），但**客户端可以要求缩到面板大小**。
       *
       * 面板画布的后备存储只有"显示尺寸 × DPR"（客户端实测 315 CSS × DPR2 =
       * 630×1400），而设备是 1080×2376 —— 直接取原始分辨率等于**过采样 2.9 倍**：
       * 解码量（≈101fps × 2.57 Mpx）、USB 带宽、帧大小全按 2.9 倍在跑，
       * 而多出来的像素在 630 宽的画布上根本显示不出来，最后被浏览器降采样丢掉。
       *
       * 按面板宽度取流（630/1080 → 0.583）之后三件事同时变好：
       *   ① 解码量降到 1/2.9 → 主线程压力大降（"流畅"）
       *   ② 同样码率下每像素比特 ×2.9，且不再经过浏览器降采样 → 更锐（"清晰"）
       *   ③ 帧更小 → 背压缓冲更浅 → 端到端延迟更低（"响应"）
       *
       * 实测（解 SPS 确认）`--scale` 真的会改编码分辨率：
       * 1.0→1080×2376、0.75→810×1782、0.667→720×1584、0.5→540×1188。
       *
       * 显式配了 `stream.defaultScale` 时以配置为准（固定画质排查用）。
       */
      const scale =
        normalizeScale(options?.scale) ??
        normalizeScale(streamConfig.defaultScale) ??
        1;
      if (scale !== 1) args.push("--scale", String(scale));

      /**
       * 码率：配置优先，否则按 scale 推导（取舍见 bitrateForScale 的注释）。
       */
      const configuredBitrate = toPositiveInt(streamConfig.bitrate, 0);
      const bitrate = configuredBitrate > 0 ? configuredBitrate : bitrateForScale(scale);
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
       * 客户端渲染侧：每帧都解码（保住 H.264 参考链，不花屏），但只在 rAF 里
       * 按 60fps 绘制最新帧（见 client.js 的 TARGET_RENDER_FPS）。
       *
       * 这里仍然传上去有两个理由：① 上游哪天修好了就自动生效；
       * ② 它出现在命令行里，排查时一眼能看到我们期望的帧率。
       */
      const fps = toPositiveInt(streamConfig.maxFps, DEFAULT_MAX_FPS);
      args.push("--fps", String(fps));

      log(
        "info",
        `启动流：${deviceId}（${bitrate / 1e6}Mbps / ${fps}fps${scale !== 1 ? ` / scale=${scale}` : ""}）`,
      );
      return client.spawnStream(args);
    },
  });

  // ── 路由 ────────────────────────────────────────────────────────────

  const access = new StreamAccessController({ key: prepareStreamAccessKey() });
  /**
   * 交互指令的加速通道。
   *
   * daemon 的 unix socket 直接吃 JSON-RPC，而 daemon 本来就在运行
   * （CLI 每条命令都会把它拉起来）—— 这条路径无需额外启动 CLI 进程，也不需要端口。
   * POSIX 历史样本中 `device.io.tap` 为 7.3ms vs CLI 104.2ms；Windows socket 被拒时
   * 会停用 RPC 并回退 CLI，不能把 POSIX 数值当成 Windows 端到端延迟。
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

  const performTap = async ({ deviceId, x, y }) => {
    const mapped = rpcForInput({ action: "tap", deviceId, x, y });
    if (rpc !== null && rpc.available && mapped !== null) {
      try {
        return await rpc.call(mapped.method, mapped.params);
      } catch (error) {
        if (!isSafeCliFallbackError(error)) throw error;
        log("warn", `daemon RPC 点击不可用，回退 CLI（${error?.code ?? error?.message ?? error}）`);
      }
    }
    return guardedClient.runJson(["io", "tap", "--device", deviceId, `${x},${y}`]);
  };

  /**
   * 设备屏幕尺寸缓存：deviceId → {width, height, at}。
   *
   * 只拿来算 scale（面板像素宽 / 设备宽），不需要实时性。60 秒足够，
   * 又能在换设备、改分辨率之后自己纠正。
   */
  const screenSizeCache = new Map();
  const SCREEN_SIZE_TTL_MS = 60_000;

  /**
   * 查屏幕尺寸的总时限。
   *
   * 这一步在 `/grant` 的**关键路径**上（`--scale` 必须在编码器启动前定下来），
   * 而 `rpc.call` 的默认超时是 15s —— 万一 daemon 半死不活，用户点"连接"就要
   * 干等 15 秒。`device.info` 正常只要 ~92ms，给 2.5s 已经很宽松；超时就放弃
   * 这次优化、按原始分辨率取流（= 今天的行为）。宁可画面大一点，也不要卡。
   */
  const SCREEN_SIZE_TIMEOUT_MS = 2_500;

  /** 给 promise 套一个超时：超时返回 fallback（原 promise 的错误照样不吞）。 */
  async function withTimeout(promise, timeoutMs, fallback) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * 取设备屏幕尺寸（逻辑像素）。
   *
   * 优先 daemon RPC 的 `device.info`（实测 91.9ms，响应里直接带 screenSize），
   * 退到 CLI `device info`（多一次进程启动 ~166ms）。都失败或超时就返回 null，
   * 让调用方退回"不缩放"——查不到尺寸不该挡住取流。
   *
   * @param {string} deviceId
   * @returns {Promise<{width: number, height: number}|null>}
   */
  async function queryScreenSize(deviceId) {
    const cached = screenSizeCache.get(deviceId);
    if (cached !== undefined && Date.now() - cached.at < SCREEN_SIZE_TTL_MS) {
      return { width: cached.width, height: cached.height };
    }

    const lookup = async () => {
      if (rpc !== null) {
        try {
          const result = await rpc.call("device.info", { deviceId });
          const screen = result?.device?.screenSize;
          if (Number.isFinite(screen?.width) && Number.isFinite(screen?.height)) {
            return { width: screen.width, height: screen.height };
          }
        } catch {
          // 通道不可用或超时：下面退 CLI
        }
      }
      try {
        const info = await guardedClient.runJson(["device", "info", "--device", deviceId]);
        const screen = info?.device?.screenSize ?? info?.screenSize;
        if (Number.isFinite(screen?.width) && Number.isFinite(screen?.height)) {
          return { width: screen.width, height: screen.height };
        }
      } catch {
        // 查不到就算了
      }
      return null;
    };

    const size = await withTimeout(lookup(), SCREEN_SIZE_TIMEOUT_MS, null);
    if (size === null) return null;
    screenSizeCache.set(deviceId, { ...size, at: Date.now() });
    return size;
  }

  /**
   * 决定这台设备该用什么分辨率/码率取流：**让编码宽度恰好等于画布后备宽度**。
   *
   * 取名函数见 lib/stream/scale-plan.js 的 `exactScale`：`clamp(画布宽 / 设备宽, 0.35, 1)`
   * 取 4 位小数。画布 532 物理像素 → 0.4926（实测编码出来就是 532×1170）。
   *
   * 为什么"精确命中"是唯一最优解（真机同一静态页面实测，Sobel 边缘能量比，
   * 1.0 = 与 LANCZOS 理想缩略图同锐）：
   *
   * | 取流 | 画布 532×1170（编码→画布） | 边缘比 |
   * |---|---|---|
   * | 精确 0.4926 | 恒等 1.00× | **1.023** |
   * | 原生 1.000 | 2.03× 缩小 | 0.994 |
   * | 干净 0.500 | 1.02× 缩小 | 0.862 |
   * | 非整数 0.750 | 1.52× 缩小 | 0.947 |
   *
   * 机制：编码端几乎无损（540 帧按原生导出与 LANCZOS 比 0.998），**糊来自重采样**
   * —— 浏览器在"只缩一点点"（1.0–1.1×）时用双线性两抽头，把笔画边缘抹成灰；
   * 隔离实验（同一张栅格图走 canvas）：恒等 0.967、1.01× 0.854、1.52× 0.924。
   * 所以差的不是"设备缩放不如浏览器"，而是**多一次重采样**：精确命中时
   * `drawImage` 恒等、一次重采样都不做，比原生还锐；而 0.5 档看着"干净"，
   * 落到画布上差 1.5% 就掉到 0.862。
   *
   * 收益：画布 532 时解码量降到 (532/1080)² ≈ **1/4**（0.62 vs 2.57 Mpx），
   * GPU 每帧纹理上传同比例下降 —— 这正是用户要的"别掉清晰度、把解码量降下来"。
   *
   * 与客户端的分工：`fixed` 只在用户钉死 `stream.defaultScale` 时为 true；
   * 默认情况下分辨率跟着画布走，由客户端既有的自适应机制带新 preferredWidth
   * 重新 grant（升档 1.02 / 降档 1.05、宽度不稳时不计时、5s 冷却、Host 3s 节流）。
   *
   * 拿不到画布宽或设备宽时一律回原生（宁可多解码，也不要凭猜测把画面缩小再放大）。
   *
   * @param {string} deviceId
   * @param {unknown} preferredWidth 客户端上报的画布物理像素宽度
   * @returns {Promise<{scale: number, bitrate: number, deviceWidth: number|null, deviceHeight: number|null, preferredWidth: number|null, fixed: boolean}>}
   */
  async function resolveStreamPlan(deviceId, preferredWidth) {
    const wanted =
      typeof preferredWidth === "number" && Number.isFinite(preferredWidth) && preferredWidth > 0
        ? Math.round(preferredWidth)
        : null;

    // 设备尺寸要查：routes 用它夹取坐标（scale=1 时是恒等映射，但夹取需要上界），
    // 客户端也用它算"画布宽度上限 = 设备原生像素 ÷ DPR"，这里还用它反算 scale。
    const screen = await queryScreenSize(deviceId);
    const deviceWidth = screen !== null && screen.width > 0 ? screen.width : null;
    const deviceHeight = screen !== null && screen.height > 0 ? screen.height : null;

    // 用户显式配了 stream.defaultScale 就照办（弱机/省流量的逃生口），
    // 此时分辨率与画布无关 → fixed: true，客户端不再白发重取请求。
    const configured = normalizeScale(streamConfig.defaultScale);
    const scale = configured ?? exactScale(wanted, deviceWidth);

    return {
      scale,
      bitrate: bitrateForScale(scale),
      deviceWidth,
      deviceHeight,
      preferredWidth: wanted,
      // fixed: 分辨率不随画布变化。只有"用户钉死 scale"这一种情况为真。
      fixed: configured !== null,
    };
  }

  const routes = new StreamRoutes({
    client: guardedClient,
    pool,
    access,
    trustedAuthorities,
    adbProbe,
    log,
    rpc,
    resolveStreamPlan,
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
    openPanel: () => routes.requestPanelOpen(),
    performTap,
  });

  if (config.mobileLoop?.enabled === true) {
    const configuredPurpose = config.mobileLoop.purpose;
    const purpose = typeof configuredPurpose === "string" && configuredPurpose.trim() !== ""
      ? configuredPurpose.trim()
      : MOBILE_LOOP_PURPOSE;
    tools[MOBILE_LOOP_TOOL_NAME] = createMobileLoopTool({
      client: guardedClient,
      purpose,
      performTap,
      getJudge: () => {
        try {
          return typeof ctx.get === "function" ? ctx.get("judgment") : undefined;
        } catch {
          return undefined;
        }
      },
    });
    log("info", `已启用 judgment mobile loop（purpose: ${purpose}）`);
  }

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
