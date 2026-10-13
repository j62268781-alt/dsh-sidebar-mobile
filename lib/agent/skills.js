/**
 * 把 mobilecli 自带的 skill 注册给模型。
 *
 * ── 为什么不自己写一份，而是打包上游的 ──────────────────────────────────
 * mobilecli 仓库里已经有一份写得很好的 playbook（`skills/mobilecli/SKILL.md`
 * + `reference.md`），内容是命令的完整用法、平台差异、以及一串踩坑记录
 * （ref 会被界面变化作废、写文本前必须先点输入框获得焦点、多设备时必须显式
 * 指定 id、远端设备要 release 否则持续计费）。这些是上游工具作者的一手经验，
 * 重新写一份只会更差，而且会随 mobilecli 版本漂移。
 *
 * 所以本包把这两份文件**原样打包**，在加载时读进来注册。上游更新时，
 * 把 `skills/mobilecli/*.md` 重新同步一次即可。
 *
 * ── 为什么剥掉 frontmatter ─────────────────────────────────────────────
 * SKILL.md 开头的 YAML frontmatter（name / description / allowed-tools）是
 * Claude Code 的技能约定。DSH 的 `ctx.skills.register()` 要的是**结构化字段**
 * （name / description / whenToUse / content），frontmatter 混在 content 里
 * 会被当成正文喂给模型，既浪费 token 又可能让模型误以为那是文档结构。
 * 所以这里解析出来，frontmatter 的 name/description 用作注册字段。
 *
 * ── 为什么防御性注册 ───────────────────────────────────────────────────
 * 没有 skills 服务的 profile（headless）不该因为本插件而加载失败。
 * 与 dsh-android 的做法一致：`ctx.inject(['skills'])` 拿不到就静默跳过，
 * 插件其余部分照常工作。
 *
 * @module dsh-sidebar-mobile/lib/skills
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 打包进本包的 skill 文件位置。
 *
 * ⚠️ 两个 `..`：本文件在 `lib/agent/` 下，要回到包根才能接上 `skills/`。
 * 这条路径与文件所在层级强耦合 —— 挪动本文件必须同步改这里
 * （曾经因为重组目录少写了一级，导致所有 skill 加载失败）。
 */
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "mobilecli");

/**
 * 解析 Markdown 的 YAML frontmatter。
 *
 * 只处理这个场景需要的标量与块状字符串，不引入 YAML 解析依赖——
 * 本插件承诺零运行时依赖。frontmatter 里出现的字段是可预期的三个
 * （name / description / allowed-tools），用一个够用的解析器即可。
 *
 * 支持：
 *   key: value
 *   key: >-     （折叠块，后续缩进行拼成一行）
 *   key: |      （字面块，保留换行）
 *
 * @param {string} text
 * @returns {{attributes: Record<string, string>, body: string}}
 */
export function parseFrontmatter(text) {
  if (!text.startsWith("---")) {
    return { attributes: {}, body: text };
  }

  // 结束分隔符：从第 4 个字符开始找下一个独占一行的 ---
  const endMatch = /\n---[ \t]*\r?\n/.exec(text.slice(3));
  if (endMatch === null) {
    return { attributes: {}, body: text };
  }

  const rawFrontmatter = text.slice(3, 3 + endMatch.index);
  const body = text.slice(3 + endMatch.index + endMatch[0].length);

  const attributes = {};
  const lines = rawFrontmatter.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);

    if (match === null) {
      index += 1;
      continue;
    }

    const key = match[1];
    let value = match[2];

    // 折叠块 >- / > 、字面块 |  / |- ：收集后续更深的缩进行
    if (/^[>|][-+]?$/.test(value.trim())) {
      const folded = value.trim().startsWith(">");
      const collected = [];
      index += 1;
      while (index < lines.length && (lines[index].trim() === "" || /^[ \t]/.test(lines[index]))) {
        collected.push(lines[index].trim());
        index += 1;
      }
      value = folded ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n").trim();
      attributes[key] = value;
      continue;
    }

    // 普通标量：去掉可能的引号
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
    index += 1;
  }

  return { attributes, body };
}

/**
 * 读取并解析打包的 skill。
 *
 * @returns {{name: string, description: string, whenToUse: string, content: string}|null}
 *   null 表示文件缺失或不可读（不该让插件加载失败）
 */
export function loadBundledSkill() {
  let raw;
  try {
    raw = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  } catch {
    return null;
  }

  // 只需要正文。frontmatter 必须剥掉：它是 Claude Code 的技能约定，
  // 混进 content 会被当作正文喂给模型，既费 token 又误导结构。
  const { body } = parseFrontmatter(raw);

  // DSH 要求 name 匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/。上游用的是 "mobilecli"，
  // 加前缀避免与用户自己装的同名技能冲突，同时表明它的来源。
  const name = "mobilecli-device-control";

  // reference.md 是命令速查表，作为正文的附录一起给出——模型需要它来查
  // 具体命令的参数，而不是靠猜。
  let reference = "";
  try {
    reference = readFileSync(join(SKILL_DIR, "reference.md"), "utf8");
  } catch {
    // 没有 reference 也能工作，正文本身已包含主要用法
  }

  /**
   * 描述与触发条件：**只针对工具不覆盖的能力**。
   *
   * ⚠️ 这两段是每次组装技能索引时都要发给模型的（常驻），所以它们不只是
   * 文案，而是**成本杠杆**：一旦描述诱导模型在本可以直接调工具的场景去
   * 载入本技能，代价是 **5137 tokens 的正文**（实测）——而技能正文一旦
   * 载入就留在对话历史里，此后每轮重发。
   *
   * 老版本写的是 "Use whenever a task involves operating or inspecting a
   * mobile device"，几乎覆盖全部场景。而这类场景**已经有 mobile_* 工具**
   * （tap / swipe / screenshot / 读屏 / 日志…），模型看到"tap 请载入我"
   * 就会白白载入 5000 多 token。实测这笔误触发是工具瘦身收益的 ~15 倍。
   *
   * 现在明确写两件事：① 只在工具做不到时用；② 列出"别为我载入"的场景。
   */
  const description =
    "Use mobilecli directly (CLI or JSON-RPC) for iOS/Android operations the built-in "
    + "mobile_* tools do NOT cover: recording, pinch/multi-touch, clipboard, on-device file "
    + "transfer, WebView inspection, crash reports, app install/uninstall/terminate, device "
    + "boot/shutdown/reboot, locale and settings, remote real-device cloud, and scripting "
    + "mobilecli itself. Skip this skill for tap/swipe/text/key input, screenshots, UI-tree "
    + "reads, app listing/launching, or logs — the tools already cover those.";

  const whenToUse =
    "Only when the wanted device operation has no mobile_* tool: recording, pinch, clipboard, "
    + "file download/upload, WebView DOM or JS, crash reports, install/uninstall/terminate, "
    + "boot/shutdown/reboot, locale/settings, raw JSON output, or scripting mobilecli. "
    + "NOT for plain tap, swipe, text input, key presses, screenshots, UI tree, app list or "
    + "launch, or device logs.";

  const content = [
    body.trim(),
    reference === "" ? "" : "\n\n---\n\n# 命令速查（mobilecli reference）\n\n" + reference.trim(),
  ]
    .filter((part) => part !== "")
    .join("");

  return {
    name,
    description,
    whenToUse,
    content,
  };
}

/**
 * 注册打包的 skill。
 *
 * @param {object} ctx 插件上下文
 * @param {Function} [log]
 * @returns {() => void} disposer（无 skills 服务时是空操作）
 */
export function registerSkills(ctx, log = () => {}) {
  const skill = loadBundledSkill();
  if (skill === null) {
    log("warn", "找不到打包的 mobilecli skill，跳过注册");
    return () => {};
  }

  // ctx.inject 的返回值形状随 DSH 版本变化：dsh-android 的注释说它是作用域
  // fiber（要调 dispose()），但不保证所有版本都提供该方法。所以既不假设它
  // 存在，也不把它的缺失当成错误——技能的注销其实由上面 skillCtx.effect(...)
  // 里的 register disposer 负责，fiber 只是兜底。
  const injection = ctx.inject(["skills"], (skillCtx) => {
    const skills = skillCtx.skills;
    if (skills === undefined || typeof skills.register !== "function") {
      log("warn", "skills 服务不可用，跳过 mobilecli skill 注册");
      return;
    }
    skillCtx.effect(
      () =>
        skills.register({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          content: skill.content,
          source: "bundled",
        }),
      "dsh-sidebar-mobile:skill",
    );
    log("info", `已注册 skill：${skill.name}（${skill.content.length} 字符）`);
  });

  return () => {
    if (injection !== null && typeof injection?.dispose === "function") {
      try {
        injection.dispose();
      } catch (error) {
        log("warn", `注销 skill 失败：${error?.message ?? error}`);
      }
    }
  };
}
