/**
 * mobilecli 二进制的解析与调用。
 *
 * mobilecli 是一个 Go 二进制，通过 npm 按平台分发（`@mobilenext/mobilecli-<os>-<arch>`
 * 是 optionalDependencies）。所以「找二进制」有三种来源，按优先级：
 *
 *   1. 配置里的 binaryPath（用户显式指定，最高优先级）
 *   2. MOBILECLI_PATH 环境变量
 *   3. PATH 上的 `mobilecli`（npm -g 安装的 shim）
 *   4. 本包 node_modules 里的平台包（mobilecli 作为本包依赖安装时）
 *
 * ── 为什么调用一律走 execFile 而不 spawn shell ──────────────────────────
 * 设备序列号、包名、文本都会作为参数传进来。execFile 把每个参数作为独立
 * argv 项传递，不经过 shell 解析，因此不会出现注入。凡是需要 shell 语义的
 * 地方（如管道）都不在本模块的职责内。
 *
 * ── 为什么区分「拿 JSON」与「拿字节流」────────────────────────────────
 * screencapture 会把 H.264/MJPEG 二进制写到 stdout，长度可达几 MB 且不封顶，
 * 绝不能用会把输出缓冲到内存里的 execFile 去接。所以：
 *   - runJson()  → execFile，输出小（几十 KB），解析 JSON
 *   - spawnStream() → spawn，把 stdout 作为流交出去，不缓冲
 *
 * @module dsh-sidebar-mobile/lib/mobilecli
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 单次命令的默认超时。设备命令偶尔会慢，但不能无限等。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** `mobilecli devices` 会启动 daemon，首次可能要等它起来。 */
const DISCOVERY_TIMEOUT_MS = 60_000;

/** stdout 上限：设备的 UI 树、应用列表都可能很大，给足空间。 */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * mobilecli 以非零退出码表示失败，同时仍可能在 stdout 打印结构化错误。
 * 这类错误要保留下来给调用方判断，而不是当成崩溃。
 */
export class MobilecliError extends Error {
  /**
   * @param {string} message 面向调用方的说明
   * @param {object} [details]
   * @param {string} [details.code] 归一化的错误码
   * @param {string} [details.stderr] 子进程 stderr
   * @param {number} [details.exitCode] 子进程退出码
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "MobilecliError";
    this.code = details.code ?? "MOBILECLI_FAILED";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode;
  }
}

/**
 * 在 PATH 里查找**真正的可执行映像**。
 *
 * 不用 `which`：一来多一个子进程，二来 which 在某些环境下不存在。
 *
 * ⚠️ Windows 上必须按扩展名找，不能只拼裸名字。npm -g 会为一个 bin 生成
 * **三个** shim，而其中两个都无法被 `execFile` 直接执行：
 *
 *     mobilecli        ← POSIX /bin/sh 脚本（给 Git Bash/WSL 用）
 *     mobilecli.cmd    ← cmd 批处理
 *     mobilecli.ps1    ← PowerShell
 *
 * 实测（Windows 11 + Node 24，npm -g 装的 mobilecli）：
 *
 *     裸名 mobilecli   → execFile 异步抛 ENOENT (errno -4058)
 *     mobilecli.cmd    → execFile 抛 EINVAL (errno -4071)
 *
 * 裸名失败是因为 libuv 直接把它交给 `CreateProcess`，而没有扩展名的文件
 * **不是合法可执行映像**；`.cmd` 失败是因为 Node 为修 CVE-2024-27980 加了
 * 加固：`shell: false` 时拒绝 `.cmd`/`.bat`。
 *
 * 所以这里只认 `.exe` / `.com` —— 真正的映像。找不到就返回 null，
 * 让调用方落到下一级（平台包），而不是返回一个"existsSync 为真但跑不起来"
 * 的路径 —— 那种路径会让错误从"装个 mobilecli"变成难懂的 ENOENT。
 *
 * @param {string} command
 * @returns {string|null} 绝对路径，或 null
 */
function findOnPath(command) {
  const pathValue = process.env.PATH ?? "";
  if (pathValue === "") return null;

  // Windows：只认真正可执行的扩展名（见上）。POSIX：裸名字就是可执行文件。
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
 * 找出 npm 全局根（形如 `<prefix>/node_modules`）。
 *
 * `npm i -g mobilecli` 的真实二进制**不在 PATH 上**，而在包内部：
 *
 *     <prefix>/node_modules/mobilecli/node_modules/@mobilenext/
 *         mobilecli-windows-amd64/mobilecli-windows-amd64.exe
 *
 * ⚠️ 注意那层 `mobilecli/node_modules/` —— 平台包是 mobilecli **自己的**
 * 依赖，不在全局根的第一层。所以两个目录都要作为解析基准：
 * 少了里层就永远 MODULE_NOT_FOUND（实测踩过）。
 *
 * PATH 上只有跑不起来的 shim（见 findOnPath），所以要么从 APPDATA 推，
 * 要么从"shim 所在目录"推 —— 后者更通用，也覆盖自定义 prefix。
 *
 * @returns {string[]} 候选的 node_modules 目录，按可信度排序
 */
function npmGlobalRoots() {
  /** @type {string[]} */
  const roots = [];

  const push = (root) => {
    if (typeof root === "string" && root !== "" && !roots.includes(root)) roots.push(root);
  };

  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData !== "") {
    push(join(appData, "npm", "node_modules"));
  }

  // shim 旁边的 node_modules 就是全局根。任何能解析到 <dir>/mobilecli
  // （或它的 .cmd 变体）的目录都算。
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const looksLikeBinDir =
      existsSync(join(dir, "mobilecli")) || existsSync(join(dir, "mobilecli.cmd"));
    if (looksLikeBinDir) push(join(dir, "node_modules"));
  }

  // 平台包是 mobilecli 自己的依赖，所以在 <root>/mobilecli/node_modules 下。
  // 在追加里层之前先固定外层顺序，避免边遍历边改数组。
  for (const root of [...roots]) {
    push(join(root, "mobilecli", "node_modules"));
  }

  return roots;
}

/**
 * 解析 mobilecli 二进制的绝对路径。
 *
 * @param {string|null|undefined} explicit 配置里指定的路径
 * @param {string} [baseUrl] 用于解析本包 node_modules 的基准（import.meta.url）
 * @returns {string|null} 绝对路径；解析不到返回 null（调用方负责给出可读的报错）
 */
export function resolveBinary(explicit, baseUrl = import.meta.url) {
  // 1) 配置显式指定。允许是绝对路径，也允许是个能被 PATH 解析的命令名。
  if (typeof explicit === "string" && explicit !== "") {
    if (existsSync(explicit)) return explicit;
    const onPath = findOnPath(explicit);
    if (onPath !== null) return onPath;
    return null;
  }

  // 2) 环境变量
  const fromEnv = process.env.MOBILECLI_PATH;
  if (typeof fromEnv === "string" && fromEnv !== "" && existsSync(fromEnv)) {
    return fromEnv;
  }

  // 3) PATH（npm -g mobilecli 装出来的 shim）
  const onPath = findOnPath("mobilecli");
  if (onPath !== null) return onPath;

  // 4) 作为本包依赖装进来的平台包，或 npm -g 装的那份。
  //
  //    ⚠️ 本包的 package.json **没有** optionalDependencies（零运行时依赖是
  //    刻意的），所以 `require.resolve` 从本包作用域出发通常找不到平台包 ——
  //    `npm i -g mobilecli` 装出来的那份在**全局** node_modules 里。
  //    实测：只查本包作用域会 MODULE_NOT_FOUND，于是整个插件在 Windows 上
  //    解析不到任何可用二进制（PATH 上只有跑不起来的 shim）。
  //
  //    所以这里显式把全局根也作为解析基准。
  try {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const pkg = `@mobilenext/mobilecli-${platform}-${arch}`;
    const ext = process.platform === "win32" ? ".exe" : "";
    const binaryName = `mobilecli-${platform}-${arch}${ext}`;

    // 先按本包作用域找（作为依赖装进来的情况），再按全局根找（npm -g 的情况）
    const require = createRequire(baseUrl);
    const searchPaths = [undefined, ...npmGlobalRoots()];

    for (const searchPath of searchPaths) {
      try {
        const pkgJson = searchPath === undefined
          ? require.resolve(`${pkg}/package.json`)
          : require.resolve(`${pkg}/package.json`, { paths: [searchPath] });
        const binary = join(pkgJson, "..", binaryName);
        if (existsSync(binary)) return binary;
      } catch {
        // 这个基准找不到，试下一个
      }
    }
  } catch {
    // 平台包没装（或装的是其它平台），落到「解析失败」
  }

  return null;
}

/**
 * mobilecli 子进程的封装。
 *
 * 每个实例对应一个二进制路径与一组环境变量；daemon 本身由 mobilecli 自己
 * 管理（首次设备命令时自动拉起，空闲 30 分钟退出），所以这里不做常驻进程，
 * 只保证每次调用都带上正确的 MOBILECLI_HOME。
 */
export class Mobilecli {
  /**
   * @param {object} options
   * @param {string} options.binary 二进制绝对路径
   * @param {string|null} [options.home] MOBILECLI_HOME；null 用 mobilecli 的默认值
   * @param {Function} [options.log] 日志函数（level, message）
   */
  constructor({ binary, home = null, log = () => {} }) {
    this.binary = binary;
    this.home = home;
    this.log = log;
  }

  /** 子进程环境：只加 MOBILECLI_HOME，其余继承，保证 PATH/ADB 等照常可见。 */
  get env() {
    const env = { ...process.env };
    if (this.home !== null) env.MOBILECLI_HOME = this.home;
    return env;
  }

  /**
   * 跑一条命令并解析 JSON 输出。
   *
   * mobilecli 的约定：成功时 stdout 是 `{"status":"ok","data":…}`，
   * 失败时可能是非零退出码 + stderr，也可能是退出码 0 但
   * `{"status":"error","error":"…"}`。两种都归一化成 MobilecliError。
   *
   * @param {string[]} args
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<any>} 解包后的 data 字段
   */
  async runJson(args, options = {}) {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let stdout;
    try {
      const result = await execFileAsync(this.binary, args, {
        env: this.env,
        timeout,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      });
      stdout = result.stdout;
    } catch (error) {
      // 超时、非零退出、二进制不存在都会走到这里。
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      const parsed = tryParseEnvelope(error?.stdout);
      const message =
        parsed?.error ??
        stderr.trim() ??
        error?.message ??
        "mobilecli command failed";
      throw new MobilecliError(message, {
        code: parsed?.error !== undefined ? "MOBILECLI_REPORTED" : "MOBILECLI_EXEC",
        stderr: stderr || String(error?.message ?? ""),
        exitCode: typeof error?.code === "number" ? error.code : undefined,
      });
    }

    const envelope = tryParseEnvelope(stdout);
    if (envelope === null) {
      throw new MobilecliError(
        `mobilecli 返回了非 JSON 输出（命令：${args.join(" ")}）`,
        { code: "MOBILECLI_BAD_OUTPUT", stderr: stdout.slice(0, 500) },
      );
    }
    if (envelope.status === "error") {
      throw new MobilecliError(envelope.error ?? "mobilecli reported an error", {
        code: "MOBILECLI_REPORTED",
      });
    }
    // 有的命令把结果直接放在顶层（如 daemon status），有的包在 data 里。
    return envelope.data !== undefined ? envelope.data : envelope;
  }

  /**
   * 启动一条长驻命令，把 stdout 交出去（不缓冲）。
   *
   * 用于 screencapture：输出是 H.264/MJPEG 二进制流，可能一直不停，
   * 只能以流的形式消费。
   *
   * @param {string[]} args
   * @returns {{child: import("node:child_process").ChildProcess, stdout: NodeJS.ReadableStream, stderr: () => string, kill: () => void}}
   */
  spawnStream(args) {
    const child = spawn(this.binary, args, {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // stderr 只留尾部：报错信息通常在最后，而流式命令的输出可能很长。
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.stderr?.on("error", () => {
      // stderr 读失败不影响 stdout 的主流程
    });

    return {
      child,
      stdout: child.stdout,
      stderr: () => stderrTail,
      kill: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // 已经退出
        }
      },
    };
  }

  /** 版本号，用于诊断。失败时返回 null 而不是抛错。 */
  async version() {
    try {
      const result = await execFileAsync(this.binary, ["--version"], {
        env: this.env,
        timeout: 10_000,
        encoding: "utf8",
      });
      return result.stdout.trim();
    } catch {
      return null;
    }
  }

  /** 列出设备。首次调用会拉起 daemon，所以超时给得宽。 */
  async listDevices({ includeOffline = false } = {}) {
    const args = ["devices"];
    if (includeOffline) args.push("--include-offline");
    const data = await this.runJson(args, { timeoutMs: DISCOVERY_TIMEOUT_MS });
    const devices = data?.devices;
    return Array.isArray(devices) ? devices : [];
  }

  /** daemon 状态。未运行时 mobilecli 返回 running:false 而不是报错。 */
  async daemonStatus() {
    try {
      return await this.runJson(["daemon", "status"], { timeoutMs: 10_000 });
    } catch (error) {
      return { running: false, error: error?.message ?? String(error) };
    }
  }

  /** 停掉 daemon。插件卸载或需要把设备让给别的工具时调用。 */
  async daemonStop() {
    try {
      return await this.runJson(["daemon", "stop"], { timeoutMs: 15_000 });
    } catch (error) {
      return { status: "error", error: error?.message ?? String(error) };
    }
  }
}

/**
 * 解析 mobilecli 的 JSON 信封。
 *
 * 输出可能被日志行污染（daemon 启动提示会打到 stderr，但有的版本也会混进
 * stdout），所以从第一个 `{` 开始截取，而不是直接 JSON.parse 整段。
 *
 * @param {unknown} text
 * @returns {any|null}
 */
function tryParseEnvelope(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // 退一步：找第一个 { 到最后一个 } 的片段
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
