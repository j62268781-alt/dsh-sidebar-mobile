# 发版

## 发布前检查

```bash
npm run verify        # build:check + 语法检查 + 150 项自测
```

自测在无设备时也能全跑完（有设备时额外验证真实调用）。

## 版本号

语义化版本。当前 `0.1.x` 表示 API 仍在演进。

需要注意的兼容性面：

| 面 | 变更影响 |
|---|---|
| 工具名（`TOOL_NAMES`） | **破坏性**：模型已记住的名字会失效。删掉的名字记得进 `REMOVED_TOOL_NAMES` |
| 路由路径（`ROUTES`） | **破坏性**：客户端缓存了 URL |
| `cordis.patch.yml` 的配置键 | 加键是兼容的，改语义不是 |
| 打包的 mobilecli skill | 内容变更只影响模型行为，不影响 API |
| `lib/client.js` | **构建产物**，由 `src/client/` 生成 —— 改完源码必须 `npm run build` 并一起提交 |

## 同步上游 skill

`skills/mobilecli/{SKILL.md,reference.md}` 是从 [mobile-next/mobilecli](https://github.com/mobile-next/mobilecli) 的 `skills/mobilecli/` 原样复制的。

上游更新时重新同步：

```bash
for f in SKILL.md reference.md; do
  curl -sL "https://raw.githubusercontent.com/mobile-next/mobilecli/main/skills/mobilecli/$f" \
    -o "skills/mobilecli/$f"
done
npm test              # 验证 frontmatter 仍能被正确剥离
```

自测里有一项专门断言"正文里没有 frontmatter 残留"。上游若改了 frontmatter 的结构（比如换成 TOML），这项会失败——那时需要更新 `lib/agent/skills.js` 的 `parseFrontmatter()`。

## 发包

## 发包

### 自动化（推荐）：打 tag 即发布

`.github/workflows/release.yml` 在推 `v*` tag 时自动发布。人工步骤只有两步：

```bash
# 1. 先 bump 版本（用 npm version 会顺手把改动提交并打上同名的 tag）
npm version patch        # 或 minor / major

# 2. 推上去，CI 接手：版本一致性门禁 → verify → npm publish → 建 GitHub Release
git push && git push --tags
```

**唯一需要手动配的东西**：仓库 Secrets 里加一个 `NPM_TOKEN`。用
**Granular Access Token**（Permissions 选 read and write，scope 覆盖
`@j62268781-alt`）—— 旧的 Automation token 已经不能新建了。

工作流里三个刻意写死的点，都是踩过的坑，改之前先读那段注释：

| 写死的东西 | 为什么 |
|---|---|
| `--registry=https://registry.npmjs.org/` | 本机默认 registry 是 `registry.npmmirror.com`（**只读镜像**），登录/发布会打错地方 |
| tag 必须等于 `package.json` 的 version | 否则 npm 上的版本和 GitHub Release 指向的东西对不上 |
| 发布前显式跑 `npm run verify` | 不依赖 `prepublishOnly`，让失败停在"测试"而不是"发布" |

也支持手动触发（Actions → Release → Run workflow），勾 **dry-run** 可以完整走一遍
`npm publish --dry-run` 而不真的发布 —— 首次验证流程或改完 workflow 后用它。

> 若以后要发**私有**仓库，把 `--provenance` 去掉（它要求公开仓库）。

### 手动发布

`npm version` 之后直接：

```bash
npm publish --registry=https://registry.npmjs.org/
```

`prepublishOnly` 会自动跑 verify。**务必带 `--registry`** —— 见上表的镜像问题。
`package.json` 的 `publishConfig.access: public` 已声明，scoped 包不会发成 private。

### 包内容

`files` 白名单：`index.js`、`lib`、`src`、`scripts`、`skills`、
`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`（加 `package.json`
与 `LICENSE`，共 21 个文件）。

**`docs/` 不进包**（仓库文档，运行时不需要）—— 所以 `docs/prototypes/` 下的
原型归档也不会随包发布，那是刻意的。

打包前确认：

```bash
npm pack --dry-run
```

要看到 `lib/client.js` 在清单里——它由 `dsh.client` 声明引用，缺了客户端就加载不出来。

## 更新 CHANGELOG

按 [Keep a Changelog](https://keepachangelog.com/) 格式。每次发版把 `[未发布]` 段落到新版本号下。

> ⚠️ 一个版本号只能对应一套内容。**发布前确认 CHANGELOG 里没有重复的版本标题** ——
> 0.1.0 就发生过一次：顶部是 `[未发布]`、底部另有一个 `[0.1.0]`，两者内容不同，
> 直接发布会让 npm 上的版本和 CHANGELOG 对不上。

## 上架 DSH 插件市场

市场条目是独立的 YAML 文件，提到 `awesome-dsh-plugin` 仓库。模板见 [market-entry.yml](market-entry.yml)，原样复制到：

```
awesome-dsh-plugin/data/plugins/j62268781-alt__dsh-sidebar-mobile.yml
```

文件名规则 `<owner>__<repo>.yml`。校验器只认 `url` / `name` / `category` / `description`，**多写键会被拒**。

`category` 取 `tools`（本插件提供设备控制工具 + 侧边栏面板）。

## 依赖许可

本插件自身 MIT。**运行时依赖为零**，所以没有传递许可问题。

但它调用外部二进制 `mobilecli`：

- 该二进制不在本包内，由用户自行安装（`npm i -g mobilecli@latest`），
- 采用 **FSL-1.1-ALv2**（Functional Source License）：源码公开但非 OSI 开源，
  禁止把该软件用于"替代它自身或提供实质相似功能的商业产品或服务"，
  但明确允许 *internal use*；
- 该许可含 **Grant of Future License**：每个版本满两年后自动额外提供 Apache-2.0。

README 里如实说明了这一点。若本插件将来要商用，需要重新评估这条。
