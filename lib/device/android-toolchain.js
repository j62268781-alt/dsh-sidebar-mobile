/**
 * Android 工具链体检：adb 在不在、能不能看到设备。
 *
 * ── 为什么必须有这个模块 ──────────────────────────────────────────────
 * mobilecli **不自己实现 adb 协议**，它调用外部的 `adb` 二进制。而 adb 缺失时
 * 它的行为是"静默降级"，不是报错：
 *
 *     实测（Windows 11 + mobilecli 1.0.19，手机已 USB 连接且驱动正常）：
 *       mobilecli devices  →  {"status":"ok","data":{"devices":[]}}
 *       exit code          →  0
 *
 * 也就是说，**exit code 是 0、JSON 也是 ok、设备列表是空的** —— 从返回值
 * 完全看不出"adb 没装"。真相只在 daemon 日志里：
 *
 *     [VERBOSE] Failed running 'adb devices', is ANDROID_HOME set correctly?
 *
 * 于是插件会把"adb 缺失"报告成"没有在线设备 / 连一台开了调试的手机"，
 * 把用户指向完全错误的方向（去检查数据线、去开 USB 调试），而实际要做的
 * 是装 adb。本模块就是为了把这两种情况**区分开**。
 *
 * ── 还有一层坑：daemon 的环境是"启动时快照" ────────────────────────────
 * 实测：mobilecli 的 daemon 是常驻进程，它继承**启动那一刻**的环境变量。
 * 所以"装完 adb 但 daemon 还是旧的"依然会看不到设备 —— 必须重启 daemon。
 * 下面 describeAdbProblem() 会把这句提示一并给出。
 *
 * @module dsh-sidebar-mobile/lib/android-toolchain
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 体检结果缓存时长。adb 不会频繁地装上/卸掉，但用户可能刚装完就刷新页面。 */
const PROBE_TTL_MS = 30_000;

/**
 * 在 PATH 里找一个**真正可执行的**文件。
 *
 * ⚠️ Windows 上只看 `.exe`：`.cmd`/`.bat` 会被 Node 拒绝
 * （CVE-2024-27980 加固，execFile 报 EINVAL），而 adb 官方分发就是 `adb.exe`。
 * POSIX 上裸名字本身就是可执行文件。
 *
 * @param {string} command 不带扩展名的命令名
 * @param {string} pathValue PATH 值
 * @returns {string|null}
 */
function findOnPath(command, pathValue) {
  if (typeof pathValue !== "string" || pathValue === "") return null;
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];

  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 常见默认安装位置（PATH / ANDROID_HOME 都没命中时才会去查）。
 *
 * ── 为什么需要这一步 ──────────────────────────────────────────────────
 * 实测踩到的真实情况：adb 装在 `D:\Android\platform-tools`，用户级 PATH 与
 * ANDROID_HOME 也都写对了，但 **DSH 进程是在这之前启动的** —— 它的环境是
 * 启动那一刻的快照，于是插件查不到 adb，报"未找到 adb，请安装"。
 * 而用户明明已经装好了。
 *
 * 所以要多查一层"有没有装，只是这个进程看不到"。这让我们能给出
 * 完全不同的、正确的那句话：**重启 DSH**，而不是**去装 adb**。
 *
 * 只枚举短路径（盘符 + 几个约定目录），不递归搜索 —— 绝不能为了诊断
 * 去扫盘。
 *
 * @returns {string[]}
 */
function wellKnownAdbPaths() {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [];

  if (process.platform === "win32") {
    // Android Studio 的默认 SDK 位置
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(join(localAppData, "Android", "Sdk", "platform-tools", exe));
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (base) candidates.push(join(base, "Android", "platform-tools", exe));
    }
    // 手动解压的常见位置。盘符就那么几个，existsSync 很便宜。
    for (const drive of ["C:", "D:", "E:", "F:"]) {
      candidates.push(join(`${drive}\\`, "Android", "platform-tools", exe));
      candidates.push(join(`${drive}\\`, "platform-tools", exe));
      candidates.push(join(`${drive}\\`, "android-sdk", "platform-tools", exe));
    }
  } else {
    const home = homedir();
    candidates.push(join(home, "Library", "Android", "sdk", "platform-tools", exe));
    candidates.push(join(home, "Android", "Sdk", "platform-tools", exe));
    candidates.push(join(home, "Android", "sdk", "platform-tools", exe));
    candidates.push(join("/usr", "lib", "android-sdk", "platform-tools", exe));
    candidates.push(join("/usr", "local", "share", "android-sdk", "platform-tools", exe));
    candidates.push(join("/opt", "android-sdk", "platform-tools", exe));
  }

  return candidates;
}

/**
 * 找出 adb 二进制。
 *
 * Android 的官方约定是 adb 躺在 `$ANDROID_HOME/platform-tools/adb`，
 * 而 `platform-tools` 通常**不在 PATH 上**（Android Studio 不自动加）。
 * 所以三级都要查，顺序按可信度：
 *
 *   1. PATH（用户手动加过，或包管理器装过）
 *   2. `$ANDROID_HOME/platform-tools/`
 *   3. `$ANDROID_SDK_ROOT/platform-tools/`
 *
 * 另外容忍一种常见误配：把 `ANDROID_HOME` 直接指到 `platform-tools`
 * 目录本身 —— 此时 `$ANDROID_HOME/adb` 才是对的。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} adb 绝对路径；找不到返回 null
 */
export function findAdb(env = process.env) {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";

  // 1) PATH
  const onPath = findOnPath("adb", env.PATH ?? "");
  if (onPath !== null) return onPath;

  // 2) / 3) SDK 根目录下的 platform-tools
  for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = env[key];
    if (typeof root !== "string" || root === "") continue;

    const inPlatformTools = join(root, "platform-tools", exe);
    if (existsSync(inPlatformTools)) return inPlatformTools;

    // 容忍 ANDROID_HOME 被直接指到 platform-tools
    const direct = join(root, exe);
    if (existsSync(direct)) return direct;
  }

  return null;
}

/**
 * 在"当前环境查不到"的前提下，看看 adb 是不是其实装了。
 *
 * 返回路径表示**装了但这台进程看不到** —— 这是"重启 DSH"就能解决的情况，
 * 与"根本没装"是两回事。见 wellKnownAdbPaths 的注释。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function findAdbOutsideEnv(env = process.env) {
  for (const candidate of wellKnownAdbPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  // 用户可能把它放在其它位置并只配在系统级 PATH 里 —— 那也只能靠重启继承
  return null;
}

/**
 * 解析 `adb devices -l` 的输出。
 *
 * 真实格式（注意 `-l` 会在状态后追加 key:value 对）：
 *
 *     List of devices attached
 *     77b8cf49               device product:haotian model:2410DPN6CC transport_id:1
 *     emulator-5554          offline
 *     ABC123                 unauthorized usb:1-1
 *
 * 另外会有以 `*` 开头的噪声行（daemon 启停提示），以及空行。
 *
 * ⚠️ 状态不只有 device/offline：`unauthorized`（手机上没点"允许调试"）
 * 和 `no permissions`（Linux udev 规则缺失）都很常见，而且**都需要用户
 * 在设备侧做动作** —— 把它们当成"没插好"会让人白折腾数据线。
 *
 * @param {string} stdout
 * @returns {{serial: string, state: string, model: string, product: string}[]}
 */
export function parseAdbDevices(stdout) {
  if (typeof stdout !== "string" || stdout === "") return [];

  const devices = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    // 表头与 daemon 提示（"* daemon not running; starting now at tcp:5037"）
    if (line.startsWith("List of devices")) continue;
    if (line.startsWith("*")) continue;

    // serial 与 state 之间是空白；state 之后是可选的 key:value 列表
    const match = /^(\S+)\s+(\S+)(.*)$/.exec(line);
    if (match === null) continue;

    const [, serial, state, rest] = match;
    devices.push({
      serial,
      state,
      model: /model:(\S+)/.exec(rest)?.[1] ?? "",
      product: /product:(\S+)/.exec(rest)?.[1] ?? "",
    });
  }
  return devices;
}

/**
 * 跑一次 `adb devices` 体检。
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   available: boolean,
 *   path: string|null,
 *   devices: {serial: string, state: string, model: string, product: string}[],
 *   usable: number,
 *   reason: "ok"|"adb-not-found"|"adb-failed"|"no-device"|"unauthorized"|"offline",
 *   error?: string,
 * }>}
 */
export async function probeAdb({ env = process.env, timeoutMs = 20_000 } = {}) {
  const path = findAdb(env);

  if (path === null) {
    /**
     * 当前环境里没有 —— 但可能只是**这个进程看不到**。
     *
     * 实测：adb 已装在 `D:\Android\platform-tools`，用户级 PATH 与
     * ANDROID_HOME 也都正确，但 DSH 进程启动得更早，环境是启动时的快照。
     * 此时若直接报"未找到 adb，请安装"，就是在让用户去装一个已经装好的
     * 东西 —— 而正确答案是"重启 DSH"。
     *
     * 所以这里再查一遍常见安装位置，把两种情况分开。
     */
    const installedPath = findAdbOutsideEnv(env);
    return {
      available: false,
      path: null,
      devices: [],
      usable: 0,
      reason: installedPath === null ? "adb-not-found" : "adb-not-in-env",
      installedPath,
    };
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(path, ["devices", "-l"], {
      env,
      timeout: timeoutMs,
      encoding: "utf8",
    }));
  } catch (error) {
    return {
      available: true,
      path,
      devices: [],
      usable: 0,
      reason: "adb-failed",
      error: error?.message ?? String(error),
    };
  }

  const devices = parseAdbDevices(stdout);
  // 只有 state === "device" 才是真正可用的
  const usable = devices.filter((d) => d.state === "device").length;

  let reason = "ok";
  if (devices.length === 0) reason = "no-device";
  else if (usable === 0) {
    reason = devices.some((d) => d.state === "unauthorized") ? "unauthorized" : "offline";
  }

  return { available: true, path, devices, usable, reason };
}

/**
 * 把体检结果翻成"给人看 + 能照着做"的一段话。
 *
 * 刻意写得具体：每一种失败都有明确的下一条动作，而不是笼统的
 * "设备连接有问题"。这是本模块存在的全部意义。
 *
 * @param {Awaited<ReturnType<typeof probeAdb>>} probe
 * @returns {{code: string, message: string, hint: string, adbPath: string|null}}
 */
export function describeAdbProblem(probe) {
  const adbPath = probe?.path ?? null;

  switch (probe?.reason) {
    case "adb-not-in-env":
      /**
       * adb 装了，但这个进程看不到它的路径。
       *
       * ⚠️ 这句话必须与"没装 adb"分开说。实测踩到的真实场景：adb 装在
       * `D:\Android\platform-tools`，用户级 PATH / ANDROID_HOME 也配好了，
       * 但 DSH 是在那之前启动的 —— 进程环境是启动那一刻的快照。
       * 此时正确的动作是**重启 DSH**（以及让 daemon 重读环境），
       * 而不是再去装一遍 adb。
       */
      return {
        code: "ADB_NOT_IN_ENV",
        adbPath: probe.installedPath ?? adbPath,
        message: `找到 adb（${probe.installedPath ?? "常见安装位置"}），但当前运行的 DSH 进程看不到它`
          + " —— 进程的环境变量是启动时的快照，之后新配的 PATH / ANDROID_HOME 不会自动生效，"
          + "**重启 DSH** 才会。所以 mobilecli 现在也找不到 adb，设备列表为空。",
        hint: "① 重启 DSH 让新环境变量进入进程；"
          + "② 重启后执行 `mobilecli daemon stop` —— 常驻 daemon 同样缓存着旧环境，"
          + "不重启它的话即使 DSH 环境对了也仍然看不到设备；"
          + "③ 若重启后仍不行，说明 PATH 没配好：把 platform-tools **目录**加进 PATH"
          + (probe.installedPath === null || probe.installedPath === undefined
            ? "。"
            : ` —— 即 ${dirname(probe.installedPath)}。`),
      };

    case "adb-not-found":
      return {
        code: "ADB_NOT_FOUND",
        adbPath,
        message: "未找到 adb —— mobilecli 依赖它来发现 Android 设备，没有 adb 时它会"
          + "静默返回空设备列表（不报错），所以看起来像“没有设备”。",
        hint: "装 Android platform-tools，并让 adb 可被找到："
          + "① 下载 https://developer.android.com/tools/releases/platform-tools 并解压；"
          + "② 把其中的 platform-tools 目录加进 PATH，或设 ANDROID_HOME 指向它的上一级；"
          + "③ 重启 DSH 让新环境变量生效，并执行 mobilecli daemon stop 让常驻 daemon 重新读取环境。",
      };

    case "adb-failed":
      return {
        code: "ADB_FAILED",
        adbPath,
        message: `找到了 adb（${adbPath}），但它执行失败：${probe.error ?? "未知原因"}`,
        hint: "手动跑一次 `adb devices` 看具体报错。常见原因：adb server 端口 5037 被占用，"
          + "或 adb 版本过旧与设备不兼容。",
      };

    case "unauthorized":
      return {
        code: "ADB_UNAUTHORIZED",
        adbPath,
        message: "adb 能看到设备，但设备处于 unauthorized —— 手机上还没有授权这台电脑。",
        hint: "在手机上点“允许 USB 调试”（建议勾选“一律允许”）。"
          + "若没弹窗：拔插数据线，或在开发者选项里点“撤销 USB 调试授权”后重连。",
      };

    case "offline":
      return {
        code: "ADB_OFFLINE",
        adbPath,
        message: "adb 能看到设备，但状态是 offline —— 连接不稳定或 adb server 状态错乱。",
        hint: "先试 `adb kill-server` 然后 `adb devices`；仍不行就重新拔插数据线，"
          + "或在手机上关掉再打开 USB 调试。",
      };

    case "no-device":
      return {
        code: "ADB_NO_DEVICE",
        adbPath,
        message: "adb 已就绪，但没有看到任何设备。",
        hint: "确认：① 手机已用数据线连接（不是仅充电的线）；"
          + "② 开发者选项里的“USB 调试”已开启；"
          + "③ 手机弹窗里点了“允许”。装完 adb 后若仍看不到，"
          + "执行 mobilecli daemon stop —— 常驻 daemon 会缓存启动时的环境变量。",
      };

    default:
      return { code: "OK", adbPath, message: "", hint: "" };
  }
}

/**
 * 带 TTL 缓存的 adb 体检器。
 *
 * 为什么需要缓存：体检要 spawn 一个 adb 进程（含 adb server 往返，实测
 * 数百毫秒）。而"没有设备"这个结论会被反复问到（面板轮询、每次点击前的
 * 设备校验），每次真跑一遍会把本来就慢的交互路径再拖长。
 *
 * ⚠️ 只缓存**成功**的体检；adb 缺失/失败的结果不缓存太久 —— 用户很可能
 * 看完提示就去装了 adb，然后刷新页面期待立刻生效。
 */
export class AdbProbe {
  #cached = null;

  /** @param {object} [options] @param {Function} [options.log] */
  constructor({ log = () => {} } = {}) {
    this.log = log;
  }

  /**
   * 取体检结果（可能命中缓存）。
   * @param {object} [options]
   * @param {boolean} [options.fresh] 绕过缓存
   * @returns {Promise<Awaited<ReturnType<typeof probeAdb>>>}
   */
  async get({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.#cached !== null) {
      // 一切正常时缓存久一点；有问题时短一点，便于用户装完 adb / 重启后
      // 立刻看到变化（"装完还要等 30 秒"会让人以为没生效）
      const ttl = this.#cached.value.reason === "ok" ? PROBE_TTL_MS : 5_000;
      if (now - this.#cached.at < ttl) return this.#cached.value;
    }

    const value = await probeAdb();
    this.#cached = { at: Date.now(), value };
    return value;
  }

  /** 清掉缓存（装完 adb、重启 daemon 后调用）。 */
  invalidate() {
    this.#cached = null;
  }
}
