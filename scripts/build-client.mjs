/**
 * 把 `src/client/` 的 JSX + CSS 编译成 `lib/client.js`。
 *
 * ── 为什么需要这一步（以及为什么它是硬性的）──────────────────────────
 *
 * DSH 把 client bundle 当**经典脚本**求值 —— 它只做 `window.__ModuleLoader__`
 * 的注册，没有任何转译。运行时解析器只有四条分支，其余一律抛错，原文：
 *
 *     seed word → memoized record → graph row → registered factory;
 *     anything else → throw (loud — the runtime mirror of the
 *     build-time bundle purity gate)
 *
 * 也就是说：**不编译就只能手写 `h(...)`，而且不能拆文件**（相对 require
 * 只对打包器产出的 chunk 有效）。DSH 自己的客户端插件同样是打包出来的
 * （`packages/client/tsdown.client.ts`）。
 *
 * ── 为什么是「只转译、不打包」────────────────────────────────────────
 *
 * 产物必须保留 `window.__ModuleLoader__.load({ factory(require) {...} })`
 * 这个外壳，`require("react")` 也得留着 —— react 由宿主注入，**不能被打进
 * 产物**（打进就违反 bundle purity，也会和宿主的 React 变成两份实例）。
 *
 * 所以这里用 esbuild 的 **transform**（不是 build）：只把 JSX 变成
 * `h(...)`，不做模块解析、不引入任何 import。好处是产物与改造前的
 * 手写文件几乎同构（同样是 `h(...)`），回归面最小。
 *
 * `jsxFactory: "h"` 是刻意的：产物因此仍是一堆 `h(...)` 调用，
 * 既有的源码断言测试继续有效（见 test-harness.mjs）。若改成自动运行时
 * （`_jsx(...)`），那 17 处断言全部要重写。
 *
 * ── CSS ──────────────────────────────────────────────────────────────
 *
 * CSS 单独放在 `src/client/styles.css`（可高亮、可格式化、可被工具处理），
 * 构建时经占位符 `__CLIENT_CSS__` 内联成一个字符串常量。
 *
 * 为什么内联而不是让客户端 fetch：DSH 把插件注入的 `<style>` 标签纳入
 * 生命周期管理（给它们打 `data-plugin` 并在卸载时清理），内联正好走这条
 * 既有通道；改成异步 fetch 会引入首屏无样式闪烁，还多一条失败路径。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const SOURCE = join(ROOT, "src", "client", "index.jsx");
const STYLES = join(ROOT, "src", "client", "styles.css");
const OUTPUT = join(ROOT, "lib", "client.js");

/** CSS 在源码里的占位符。必须是合法标识符，否则 esbuild 会拒绝解析。 */
const CSS_PLACEHOLDER = "__CLIENT_CSS__";

/**
 * 取 esbuild。**用动态 import 而不是顶层 import** —— 顶层 import 在没装依赖时
 * 会抛一条 `ERR_MODULE_NOT_FOUND` 的栈，对使用者毫无信息量。换成一个明确的提示。
 *
 * 要区分两类人：
 *   · **安装方**（git 依赖）根本不需要 esbuild —— 产物已提交进仓库。
 *   · **改客户端源码的人**才需要，所以提示要写清是给谁的。
 */
async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    throw new Error(
      "缺少 esbuild（本仓库唯一的 devDependency）。\n"
        + "  只安装/使用本插件不需要它 —— lib/client.js 已随仓库提交。\n"
        + "  要改 src/client/ 才需要：先跑 npm install。",
    );
  }
}

const BANNER = `/**
 * ⚠️ 本文件是**构建产物**，不要直接编辑 —— 改动会在下次构建时被覆盖。
 *
 * 源码：src/client/index.jsx（布局与逻辑）
 *       src/client/styles.css（样式）
 * 构建：npm run build
 *
 * 产物为什么要提交进仓库：本插件以 git 依赖安装
 * （profile 里写的是 github:j62268781-alt/dsh-sidebar-mobile），
 * 提交产物能让安装方**完全不需要工具链**。代价是产物可能漂移，
 * 所以 npm run verify 会校验它是否与源码同步（见 build:check）。
 */
`;

/**
 * 编译一次，返回产物文本。
 *
 * 抽成函数是为了让 `--check` 能复用同一条代码路径 —— 校验用的产物与
 * 真正写出的产物必须由同一段逻辑产生，否则校验本身就成了另一个漂移源。
 *
 * @returns {Promise<string>} 产物文本
 */
export async function buildClient() {
  const [source, css] = await Promise.all([
    readFile(SOURCE, "utf8"),
    readFile(STYLES, "utf8"),
  ]);

  if (!source.includes(CSS_PLACEHOLDER)) {
    throw new Error(
      `src/client/index.jsx 里找不到 CSS 占位符 ${CSS_PLACEHOLDER}。`
        + "样式必须经它注入，否则构建出来的面板会完全没有样式。",
    );
  }

  const { transform } = await loadEsbuild();
  const result = await transform(source, {
    loader: "jsx",
    // 产物保持 h(...) 形态，与改造前同构（见文件头）。
    jsxFactory: "h",
    jsxFragment: "Fragment",
    /**
     * ⚠️ 必须显式设 utf8。esbuild 默认 charset 是 **ascii**，会把每个非 ASCII
     * 字符转义成 `\uXXXX` —— 对一个字符串与注释几乎全中文的项目，那会让
     * 提交进仓库的产物变成一屏 `\u771F\u673A`，没法读、没法 review，
     * 也没法和浏览器里实际显示的字对照。实测确认过这个默认值。
     */
    charset: "utf8",
    // 不压缩：产物要能读、要能被源码断言测试检查，
    // 而且这个文件只在本地加载，体积不是瓶颈。
    minify: false,
    target: "es2022",
    legalComments: "none",
  });

  /**
   * 用 JSON.stringify 而不是自己拼引号/转义：CSS 里有中文注释、
   * 引号、反斜杠与换行，手写的转义几乎必然会漏掉一种。
   */
  let inlined = result.code.replaceAll(
    CSS_PLACEHOLDER,
    JSON.stringify(css),
  );

  if (inlined.includes(CSS_PLACEHOLDER)) {
    throw new Error(`CSS 占位符没有被完全替换（${CSS_PLACEHOLDER}）`);
  }

  /**
   * 去掉 esbuild 给每个 JSX 元素加的 `/* @__PURE__ *​/` 标注。
   *
   * 它是给**下游打包器**做摇树用的（告诉它们 `h(...)` 无副作用）。
   * 本插件不打包产物，所以这些标注没有作用，只让每个元素那行变长、
   * 把提交进仓库的产物弄脏。
   *
   * 安全性：它只是一段注释，删掉不可能改变运行时行为。
   */
  inlined = inlined.replace(/\/\* @__PURE__ \*\/\s?/gu, "");

  return BANNER + inlined;
}

/** 写出产物。 */
async function write() {
  const code = await buildClient();
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, code, "utf8");
  const lines = code.split("\n").length;
  console.log(`已写出 lib/client.js（${lines} 行）`);
}

/**
 * 校验提交的产物与源码同步。
 *
 * 为什么必须有：产物进了仓库就会漂移 —— 改了 src 忘了构建，仓库里的
 * lib/client.js 就是旧的，而**安装方看到的正是这个旧文件**。那种 bug
 * 极难察觉（代码明明改了，行为却没变）。所以让它在 verify 阶段就失败。
 */
async function check() {
  const expected = await buildClient();
  let actual;
  try {
    actual = await readFile(OUTPUT, "utf8");
  } catch {
    throw new Error("lib/client.js 不存在。跑 npm run build 生成它。");
  }
  if (actual !== expected) {
    throw new Error(
      "lib/client.js 与 src/client/ 不同步。\n"
        + "  源码改过但没重新构建。跑 npm run build 并把它一起提交。",
    );
  }
  console.log("lib/client.js 与源码同步 ✅");
}

const mode = process.argv[2];
try {
  if (mode === "--check") await check();
  else await write();
} catch (error) {
  console.error(`构建失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
