/**
 * 【原型 · 未接线 · 不随包发布】读 Flutter 的真实 widget 树（Dart VM Service）。
 *
 * ⚠️ 这份代码**没有任何调用方**，放在 `docs/prototypes/` 而不是 `lib/`：
 *    `package.json` 的 `files` 含 `lib` 但不含 `docs`。放进 lib 就会随包
 *    发布 21.6 kB 死代码给每个安装者（`npm pack` 实测确认）。
 *
 * 它原先是要实现 `mobile_flutter_tree` 的，而那个工具已经删除 —— 因为它的
 * 旧实现只是 `dump ui` 的副本，描述却声称直连 VM Service。所以这份原型现在
 * 只是**留档**：真要重做，`docs/FLUTTER-TREE-RESEARCH.md` 里的协议细节
 * （鉴权码只在启动瞬间出现、token 必须带结尾的 `=`、参数名是 objectGroup、
 * 摘要树也有 240 万字符必须裁剪）比这份代码更值钱。
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────────
 *
 * 原先 `mobile_flutter_tree` 的实现只是 `dump ui` 的副本（见 lib/agent/tools.js），
 * 拿到的是 Android **无障碍树**：Flutter 整屏画布在那一层只剩匿名 View，
 * 没有文字、没有语义、只有坐标。工具描述却写着"直连 Dart VM Service" ——
 * 名不副实。本模块做的是描述里那件事。
 *
 * ── 为什么要一张判定表（而不是一串 if）────────────────────────────────
 *
 * 这个功能的失败模式**不是报错，而是静默给出错误的树**：App 不是 debug、
 * 或没抓到鉴权码时，随手退回无障碍树，使用者会以为读到了 Flutter 树。
 *
 * 所以「观测到什么 → 走哪条路」写成一张**显式表**（FLUTTER_RULES），
 * 每条规则可单测，命中后连同**理由**一起返回，由工具转达给使用者。
 * 新增信号时只往表里加一行。
 *
 * ── 协议事实（全部实测，写错任何一条都会静默失败）────────────────────
 *
 *  · **端口**：debug 构建的 Flutter 引擎在**设备内** `127.0.0.1:<port>` 监听。
 *    扫应用 uid 的 `/proc/net/tcp` 即可拿到 —— **不需要鉴权码**。
 *    实测一加 12 / Android 16：`0100007F:B301`（127.0.0.1:45825）。
 *
 *  · **鉴权码**：只在 App **启动那一刻**打进 logcat，形如
 *        The Dart VM service is listening on http://127.0.0.1:42123/FD8A2x4kjnk=/
 *    App 跑久了这行会滚出缓冲区，之后就**再也拿不到**（除非重启 App）。
 *    实测搜过：全缓冲区 logcat、应用私有数据（run-as）、`/proc/<pid>/environ`、
 *    mDNS —— 都没有。
 *
 *  · **URL 里的 token 必须带结尾的 `=`**：
 *        /FD8A2x4kjnk=/getVM  → 200
 *        /FD8A2x4kjnk/getVM   → 403   ← 剥掉 = 就废了
 *
 *  · **inspector 扩展的参数名是 `objectGroup`**，不是旧版的 `groupName`
 *    （传错会报 `Null check operator used on a null value`）。
 *
 *  · **不能用 debugDumpApp 当结果**：实测该 App 返回 662 万字符。
 *    用 `ext.flutter.inspector.getRootWidgetSummaryTree`（约 240 万，
 *    再按下面的规则裁剪）。
 *
 *  · **节点带 `creationLocation.file:line`** —— 这是最有价值的字段：
 *    能把屏幕上每个 widget 映射回源码。实测目标 App（tcl_jiguang）
 *    的工程本机就有，文件路径可直接打开。
 *
 *  · 只有 **debug** 构建才有 VM Service：release 的 APK 里是 AOT 产物
 *    `lib/arm64-v8a/libapp.so`；debug 没有它（JIT）。
 *
 * ── 为什么用 adb 而不是 mobilecli ───────────────────────────────────
 *
 * 上面这些探测（`/proc/net/tcp`、`/proc/<pid>/maps`、`logcat`、`forward`）
 * mobilecli **一个都没有暴露**（`dump/ui` 没有 Flutter 选项，CLI 里没有
 * 任何 flutter / forward 命令）。所以这里直接用 adb —— 与
 * android-toolchain.js 的体检路径一致。
 */

import { execFile } from "node:child_process";

/** 策略。工具据此决定"要不要退回无障碍树"。 */
export const STRATEGY = {
  /** 走 Dart VM Service，能拿到真正的 widget 树。 */
  VM_SERVICE: "vm-service",
  /** 拿不到 Flutter 树；退回无障碍树，并说明**为什么**。 */
  A11Y_FALLBACK: "a11y-fallback",
  /** 技术上可行，但鉴权码已丢；唯一的办法是重启 App。 */
  NEED_RESTART: "need-restart",
};

/**
 * ── 判定表 ────────────────────────────────────────────────────────────
 *
 * 自上而下求值，**第一条命中的胜出**。顺序即优先级。
 *
 * 每条：`{ code, when(facts), strategy, reason(facts) }`
 *   · `code`   —— 给程序判断用（稳定，别改）
 *   · `when`   —— 谓词，输入是观测事实
 *   · `reason` —— 给人看的一句话，会经工具转达给使用者
 *
 * ⚠️ 加规则时注意顺序：越具体的越靠前。默认兜底在最后。
 */
export const FLUTTER_RULES = [
  {
    code: "not-android",
    when: (f) => f.platform !== "android",
    strategy: STRATEGY.A11Y_FALLBACK,
    reason: (f) => `目前只实现了 Android 的 VM Service 发现（当前平台：${f.platform ?? "未知"}）。`,
  },
  {
    code: "no-foreground",
    when: (f) => f.foreground === null || f.foreground === undefined,
    strategy: STRATEGY.A11Y_FALLBACK,
    reason: () => "看不到前台应用（屏幕可能已灭或处于锁屏）。",
  },
  {
    code: "not-flutter",
    when: (f) => f.hasFlutterEngine === false,
    strategy: STRATEGY.A11Y_FALLBACK,
    reason: (f) => `前台应用 ${f.foreground?.package ?? ""} 不是 Flutter 应用（进程里没有 libflutter.so）。`,
  },
  {
    code: "release-build",
    when: (f) => f.isDebuggable === false,
    strategy: STRATEGY.A11Y_FALLBACK,
    reason: (f) =>
      `前台应用 ${f.foreground?.package ?? ""} 是 release 构建，没有 Dart VM Service ——`
      + " 只有 debug 构建才带得动 widget 树。退回无障碍树读取（Flutter 在那层只剩匿名 View）。",
  },
  {
    code: "no-vm-service",
    when: (f) => f.vmServicePort === null || f.vmServicePort === undefined,
    strategy: STRATEGY.A11Y_FALLBACK,
    reason: (f) =>
      `前台应用 ${f.foreground?.package ?? ""} 虽是 debug 构建，但没有 VM Service 在监听`
      + "（引擎可能还没起来，或用了 --disable-service-auth-codes 之外的裁剪）。",
  },
  {
    code: "token-lost",
    when: (f) => f.vmServiceUri === null || f.vmServiceUri === undefined,
    strategy: STRATEGY.NEED_RESTART,
    reason: (f) =>
      `VM Service 在 ${f.vmServicePort} 端口上活着，但**鉴权码已经拿不到了** ——`
      + " 它只在 App 启动那一刻写进 logcat，这台 App 已经跑太久，那行滚出了缓冲区。"
      + " 重启一次 App 就能读到真正的 widget 树（重启后立刻再调本工具）。",
  },
  {
    code: "unreachable",
    when: (f) => f.reachable === false,
    strategy: STRATEGY.NEED_RESTART,
    reason: (f) =>
      `VM Service（${f.vmServicePort}）对鉴权码 ${maskToken(f.vmServiceUri)} 返回了拒绝 ——`
      + " 通常意味着 App 重启过、缓存下来的鉴权码已经失效。重启 App 后重试。",
  },
  {
    code: "ok",
    when: () => true,
    strategy: STRATEGY.VM_SERVICE,
    reason: (f) => `走 Dart VM Service（端口 ${f.vmServicePort}）。`,
  },
];

/** 把 token 遮掉再进日志/结果：它等于设备的调试后门，不该到处留。 */
export function maskToken(uri) {
  if (typeof uri !== "string" || uri === "") return "(无)";
  return uri.replace(/\/[^/]+\/$/u, "/***/");
}

/**
 * 按判定表得出策略。
 *
 * @param {object} facts 观测事实（见 FLUTTER_RULES 的 when）
 * @returns {{strategy: string, code: string, reason: string}}
 */
export function decideFlutterStrategy(facts) {
  for (const rule of FLUTTER_RULES) {
    if (rule.when(facts)) {
      return { strategy: rule.strategy, code: rule.code, reason: rule.reason(facts) };
    }
  }
  // FLUTTER_RULES 最后一条是 when: () => true，走不到这里；留着防御未来的改动。
  throw new Error("判定表没有兜底规则 —— 请检查 FLUTTER_RULES 最后一条");
}

/**
 * 从 logcat 文本里抽出 VM Service URI。
 *
 * 实测格式（Flutter 引擎自己打的）：
 *   I/flutter: The Dart VM service is listening on http://127.0.0.1:42123/FD8A2x4kjnk=/
 *
 * 取**最后一条**：App 重启会再打一行，新的才有效。
 *
 * @param {string} logText
 * @returns {string|null} 形如 `http://127.0.0.1:42123/FD8A2x4kjnk=/`
 */
export function parseVmServiceUri(logText) {
  if (typeof logText !== "string" || logText === "") return null;
  const re = /http:\/\/127\.0\.0\.1:(\d+)\/([A-Za-z0-9_=-]+)\//gu;
  let last = null;
  for (const m of logText.matchAll(re)) last = m[0];
  return last;
}

/**
 * 从 `/proc/net/tcp` 或 `/proc/net/tcp6` 的内容里找出某个 uid 在
 * 127.0.0.1 上监听的端口。
 *
 * `/proc/net/tcp` 的格式（空格分隔，第 2 列是 `地址:端口` 十六进制）：
 *   sl  local_address rem_address   st ... uid
 *   0:  0100007F:B301 00000000:0000 0A ... 10825
 *
 *   · `0100007F` 小端表示的 127.0.0.1
 *   · `0A` 是 LISTEN
 *
 * @param {string} tcpText 内核表内容
 * @param {number|string} uid 应用 uid
 * @returns {number|null} 端口；找不到返回 null
 */
export function findVmServicePort(tcpText, uid) {
  if (typeof tcpText !== "string" || tcpText === "") return null;
  const wantUid = String(uid);
  let found = null;
  for (const line of tcpText.split("\n")) {
    const f = line.trim().split(/\s+/u);
    if (f.length < 10 || f[0] === "sl") continue;
    if (f[3] !== "0A") continue;            // 只要 LISTEN
    if (String(f[7]) !== wantUid) continue; // 只要这个应用
    const [addr, portHex] = f[1].split(":");
    if (addr === undefined || portHex === undefined) continue;
    // 0100007F = 127.0.0.1（小端）；tcp6 里是 …FFFF0000F745900A 之类，也含 0100007F
    if (!addr.endsWith("0100007F") && addr !== "0100007F") continue;
    const port = Number.parseInt(portHex, 16);
    if (Number.isFinite(port) && port > 0) found = port;
  }
  return found;
}

/**
 * 从 `/proc/<pid>/maps` 判断进程是否加载了 Flutter 引擎。
 *
 * 比"拉 APK 看有没有 flutter_assets"便宜得多（那要几十 MB）。
 *
 * @param {string} mapsText
 * @returns {boolean}
 */
export function isFlutterProcess(mapsText) {
  return typeof mapsText === "string" && mapsText.includes("libflutter.so");
}

/** 这个源文件是不是 Flutter 框架或第三方包（不是应用自己的代码）。 */
export function isFrameworkFile(file) {
  if (typeof file !== "string" || file === "") return false;
  return file.includes("/flutter/lib/")
    || file.includes("/packages/flutter/")
    || file.includes(".pub-cache/")
    || file.includes("dart-sdk/");
}

/**
 * 把 inspector 的摘要树磨成**体积可控、可读**的形状。
 *
 * 为什么必须裁：实测目标 App 的摘要树有 4921 个节点 / 240 万字符，
 * 直接当工具结果会把上下文冲掉。而且其中绝大多数是 `SizedBox`/`Container`
 * 这类框架包装，对"看懂界面结构"没有信息量。
 *
 * 裁剪规则：
 *   · `scope: "app"`（默认）只留**应用自己代码里的**节点 —— 判据是
 *     creationLocation.file 落在 Flutter SDK / .pub-cache 之外。
 *     实测该 App 有 94 个源文件，其中应用自己的约占一半。
 *   · `maxNodes` 卡总数，`maxDepth` 卡深度；截断时在结果里**如实标记**。
 *   · depth 保留**绝对深度**，所以即使中间层被跳过，层级感仍在。
 *
 * @param {object} tree `getRootWidgetSummaryTree` 的 result 节点
 * @param {{scope?: "app"|"all", maxNodes?: number, maxDepth?: number}} [options]
 * @returns {{nodes: Array<object>, total: number, kept: number, truncated: boolean}}
 */
export function shapeWidgetTree(tree, options = {}) {
  const { scope = "app", maxNodes = 250, maxDepth = 60 } = options;
  const nodes = [];
  let total = 0;
  let truncated = false;

  const visit = (node, depth) => {
    if (node === null || typeof node !== "object") return;
    total += 1;
    const file = node.creationLocation?.file ?? null;
    const own = file !== null && !isFrameworkFile(file);
    const keep = scope === "all" || own;

    if (keep) {
      if (nodes.length >= maxNodes || depth > maxDepth) {
        truncated = true;
      } else {
        nodes.push({
          depth,
          widget: node.widgetRuntimeType ?? node.description ?? "?",
          ...(file === null ? {} : { file: file.replace(/^file:\/\//u, "") }),
          ...(node.creationLocation?.line === undefined
            ? {}
            : { line: node.creationLocation.line }),
          // 有 Key 的节点通常是被测试或状态逻辑盯上的，值得单独标出
          ...(node.description !== undefined
            && node.description !== node.widgetRuntimeType
            && String(node.description).includes("key:")
            ? { description: node.description }
            : {}),
          ...(node.stateful === true ? { stateful: true } : {}),
        });
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };

  visit(tree, 0);
  return { nodes, total, kept: nodes.length, truncated };
}

// ── IO 层 ───────────────────────────────────────────────────────────────
//
// 以上全是纯函数（可单测）；下面才碰设备。

/** 单次 adb 命令的默认超时。 */
const ADB_TIMEOUT_MS = 20_000;

/** logcat 读取量。够覆盖一次 App 启动即可，不必拉全量。 */
const LOGCAT_LINES = 4000;

/** VM Service 请求超时。摘要树可能几百 KB，给宽一点。 */
const RPC_TIMEOUT_MS = 60_000;

/**
 * 跑一条 adb 命令，返回 stdout。
 *
 * 与 mobilecli.js 同样的取舍：用 execFile 而不是 shell，参数逐个传，
 * 不经过 shell 解析（设备序列号、包名都会作为参数进来）。
 */
function runAdb(adbPath, args, timeoutMs = ADB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null && stdout === "") {
          reject(error);
          return;
        }
        resolve(stdout ?? "");
      });
  });
}

/** 一次 VM Service JSON-RPC（HTTP GET）。 */
async function vmRpc(uri, method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  const base = uri.replace(/\/$/u, "");       // ⚠️ token 的结尾 `=` 必须留着
  const url = new URL(`${base}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // 403 = 鉴权码失效/不对，这是判定表里 unreachable 那条
    const body = await res.text().catch(() => "");
    const err = new Error(`VM Service ${res.status}: ${body.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (json.error !== undefined) {
    const d = json.error.data;
    throw new Error(`VM Service 错误：${typeof d === "string" ? d : JSON.stringify(d ?? json.error)}`);
  }
  return json.result;
}

/**
 * 一个设备的 Flutter VM Service 访问器。
 *
 * 用法：
 *   const vm = new FlutterVm({ adbPath, serial, log });
 *   const facts = await vm.probeFacts();
 *   const decision = decideFlutterStrategy(facts);
 *   if (decision.strategy === STRATEGY.VM_SERVICE) {
 *     const tree = await vm.readWidgetTree(facts.vmServiceUri, opts);
 *   }
 */
export class FlutterVm {
  #adbPath;
  #serial;
  #log;

  /**
   * @param {{adbPath: string, serial: string, log?: Function}} options
   */
  constructor({ adbPath, serial, log = () => {} }) {
    this.#adbPath = adbPath;
    this.#serial = serial;
    this.#log = log;
  }

  #adb(args, timeoutMs) {
    return runAdb(this.#adbPath, ["-s", this.#serial, ...args], timeoutMs);
  }

  /**
   * 前台应用。
   *
   * ⚠️ 用 `dumpsys activity activities` 的 `topResumedActivity`，而不是
   * `dumpsys window` 的 `mCurrentFocus` —— 实测后者在部分机型（一加 12 /
   * Android 16）返回 `null`，即使屏幕亮着、应用在前台。
   *
   * @returns {Promise<{package: string, pid: number|null}|null>}
   */
  async foregroundApp() {
    let dump = "";
    try {
      dump = await this.#adb(["shell", "dumpsys", "activity", "activities"]);
    } catch (error) {
      this.#log("warn", `读前台应用失败：${error?.message ?? error}`);
      return null;
    }
    const m = dump.match(/topResumedActivity=ActivityRecord\{\S+\s+\S+\s+([\w.]+)\/([\w.$]+)/u);
    if (m === null) return null;
    const pkg = m[1];
    // pid 单独查：dumpsys 只给组件名
    let pid = null;
    try {
      const out = await this.#adb(["shell", "pidof", pkg]);
      const n = Number.parseInt(out.trim(), 10);
      if (Number.isFinite(n)) pid = n;
    } catch {
      // 拿不到 pid 不算致命：后面的探测都会返回"未知"
    }
    return { package: pkg, pid };
  }

  /**
   * 采集所有观测事实，喂给判定表。
   *
   * 每一步都容错：探测失败留 null（= 未知），让判定表按"未知"处理，
   * 而不是整个抛错 —— 因为这里要产出的是**判断依据**，不是结果本身。
   *
   * @returns {Promise<object>} facts
   */
  async probeFacts() {
    const facts = {
      platform: "android",   // 本类只处理 Android；iOS 由判定表第一条挡掉
      foreground: null,
      hasFlutterEngine: null,
      isDebuggable: null,
      vmServicePort: null,
      vmServiceUri: null,
      reachable: null,
    };

    const fg = await this.foregroundApp();
    facts.foreground = fg;
    if (fg === null) return facts;

    // ① 是不是 Flutter（进程有没有加载 libflutter.so）
    if (fg.pid !== null) {
      try {
        const maps = await this.#adb(["shell", "cat", `/proc/${fg.pid}/maps`]);
        facts.hasFlutterEngine = isFlutterProcess(maps);
      } catch {
        this.#log("warn", "读 /proc/<pid>/maps 失败，无法判断是否 Flutter 应用");
      }
    }

    // ② 是否 debug 构建
    try {
      const dump = await this.#adb(["shell", "dumpsys", "package", fg.package]);
      const flags = dump.match(/flags=\[([^\]]*)\]/u)?.[1] ?? "";
      if (flags !== "") facts.isDebuggable = flags.includes("DEBUGGABLE");
    } catch {
      this.#log("warn", `读 ${fg.package} 的包信息失败，无法判断是否 debug 构建`);
    }

    // ③ VM Service 端口：扫该应用 uid 的监听 socket
    if (fg.pid !== null) {
      try {
        const status = await this.#adb(["shell", "cat", `/proc/${fg.pid}/status`]);
        const uid = status.match(/^Uid:\s+(\d+)/mu)?.[1] ?? null;
        if (uid !== null) {
          const [tcp, tcp6] = await Promise.all([
            this.#adb(["shell", "cat", "/proc/net/tcp"]),
            this.#adb(["shell", "cat", "/proc/net/tcp6"]),
          ]);
          facts.vmServicePort = findVmServicePort(tcp, uid) ?? findVmServicePort(tcp6, uid);
        }
      } catch {
        this.#log("warn", "读 /proc/net/tcp 失败，无法定位 VM Service 端口");
      }
    }

    // ④ 鉴权码：只在 App 启动时写进 logcat
    try {
      const log = await this.#adb(["logcat", "-d", "-t", String(LOGCAT_LINES)]);
      facts.vmServiceUri = parseVmServiceUri(log);
    } catch {
      this.#log("warn", "读 logcat 失败，拿不到 VM Service 鉴权码");
    }

    // ⑤ 通了才算数 —— 鉴权码可能是 App 重启前的，早失效了
    if (facts.vmServiceUri !== null && facts.vmServicePort !== null) {
      try {
        await this.#forward(facts.vmServicePort);
        await vmRpc(facts.vmServiceUri, "getVM", {}, 8000);
        facts.reachable = true;
      } catch {
        facts.reachable = false;
      }
    }

    return facts;
  }

  /** 把设备端口映射到本机，好让 fetch 够得着。 */
  async #forward(port) {
    const spec = `tcp:${port}`;
    try {
      const existing = await runAdb(this.#adbPath, ["forward", "--list"]);
      if (existing.includes(`${this.#serial} ${spec}`)) return;
    } catch {
      // 列不出来就直接建，adb 对重复 forward 是幂等的
    }
    await runAdb(this.#adbPath, ["-s", this.#serial, "forward", spec, spec]);
  }

  /**
   * 读真正的 widget 树。
   *
   * @param {string} uri probeFacts() 给的 VM Service URI（含鉴权码）
   * @param {{scope?: "app"|"all", maxNodes?: number, maxDepth?: number}} [options]
   * @returns {Promise<object>} shapeWidgetTree 的结果 + isolate 信息
   */
  async readWidgetTree(uri, options = {}) {
    const vm = await vmRpc(uri, "getVM");
    const isolates = vm.isolates ?? [];
    if (isolates.length === 0) throw new Error("VM Service 里没有 isolate，应用可能已退出");
    // 取 main isolate（实测只有一个，但别假定）
    const iso = isolates.find((i) => i.name === "main") ?? isolates[0];

    const raw = await vmRpc(uri, "ext.flutter.inspector.getRootWidgetSummaryTree", {
      isolateId: iso.id,
      // ⚠️ 参数名是 objectGroup；旧版的 groupName 会报
      //    "Null check operator used on a null value"
      objectGroup: "dsh-mobile-tree",
    });

    const shaped = shapeWidgetTree(raw, options);
    return {
      ...shaped,
      isolate: iso.id,
      dartVersion: String(vm.version ?? "").split(" (")[0],
    };
  }

  /** 撤掉本模块建立的端口映射（可选，用于收尾）。 */
  async unforward(port) {
    try {
      await runAdb(this.#adbPath, ["-s", this.#serial, "forward", "--remove", `tcp:${port}`]);
    } catch {
      // 收尾失败不影响结果
    }
  }
}
