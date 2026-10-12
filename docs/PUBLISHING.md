# 发版

## 发布前检查

```bash
npm run verify        # 语法检查 + 43 项自测
node --check lib/client.js
```

自测在无设备时也能全跑完（有设备时额外验证真实调用）。

## 版本号

语义化版本。当前 `0.1.x` 表示 API 仍在演进。

需要注意的兼容性面：

| 面 | 变更影响 |
|---|---|
| 工具名（`TOOL_NAMES`） | **破坏性**：模型已记住的名字会失效 |
| 路由路径（`ROUTES`） | **破坏性**：客户端缓存了 URL |
| `cordis.patch.yml` 的配置键 | 加键是兼容的，改语义不是 |
| 打包的 mobilecli skill | 内容变更只影响模型行为，不影响 API |
| `lib/client.js` | 单文件，无构建，改完刷新即生效 |

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

自测里有一项专门断言"正文里没有 frontmatter 残留"。上游若改了 frontmatter 的结构（比如换成 TOML），这项会失败——那时需要更新 `lib/skills.js` 的 `parseFrontmatter()`。

## 发包

```bash
npm version patch      # 或 minor / major
npm publish            # prepublishOnly 会自动跑 verify

git push && git push --tags
```

`files` 白名单决定了包内容：`index.js`、`lib`、`skills`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`。**`docs/` 不进包**（它是仓库文档，不是运行时需要的东西）。

打包前确认：

```bash
npm pack --dry-run
```

要看到 `lib/client.js` 在清单里——它由 `dsh.client` 声明引用，缺了客户端就加载不出来。

## 更新 CHANGELOG

按 [Keep a Changelog](https://keepachangelog.com/) 格式。每次发版把 `[未发布]` 段落到新版本号下。

## 上架 DSH 插件市场

市场条目是独立的 YAML 文件，提到 `awesome-dsh-plugin` 仓库。模板见 [market-entry.yml](market-entry.yml)，原样复制到：

```
awesome-dsh-plugin/data/plugins/j62268781-alt__dsh-client-ui-sidebar-mobile.yml
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
