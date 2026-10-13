# 变更日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)，
变更记录格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

### 修复

- **画面被压成一条横向小条（真机截图确认）**：canvas 尺寸写成了
  「读它自己的 `getBoundingClientRect()` × DPR」，那是**循环依赖**：

  `<canvas>` 没设 CSS 尺寸时默认 300×150（宽高比 2.0），而
  `.mbm-media` 只有 max-*，元素就按 300×150 排版 → 读到它 → 后备存储
  设成 600×300 → 显示仍是 300×150 → 自洽地卡在 2.0，
  与设备的 1080×2376（0.45）毫无关系。

  实测复现：连续 6 帧都停在 330×165（2.0），正确值应 ~318×700。

  现在由**帧的真实宽高比** + **父容器可用空间**推出 contain 尺寸，
  同时写回 CSS 尺寸与后备存储。`.mbm-media` 加 `flex: none`
  （否则 flex 容器会拉伸它，比例又丢）。

  实测：宽高比 2.000 → **0.455**（目标 0.455），并覆盖 5 组
  「容器 × 帧」组合（矮面板/横屏帧/窄面板/含 padding）全部不溢出且比例正确。
  坐标换算验证：左上→(3,2)、右下→(1077,2374)、中心→(540,1188)。
  自测补 3 条，94 → 97。

- **MJPEG 背压丢弃会切坏帧（iOS 模拟器实测）**：拥塞丢弃的「按帧边界对齐」
  逻辑两种格式共用了 H.264 起始码（`00 00 01`），但 **MJPEG 的帧边界是
  multipart boundary，不是起始码**。JPEG 像素数据里天然大量出现 `00 00 01`
  （实测 36 MB 流里 1925 个三字节 + 3465 个四字节），按它截断会切出不含
  boundary 的半截 JPEG —— 那一帧永远等不到结束标记（浏览器不渲染），
  恢复投递后的残余字节还会被当成上一帧的像素（该帧损坏）。

  实测对照（真实 iOS 模拟器流，抽样 719 个 64 KB 块）：

  | 对齐方式 | 切在帧中间 |
  |---|---|
  | 旧：H.264 起始码 | **506** ❌ |
  | 新：multipart boundary | **0** ✅ |

  MJPEG 实测 21.8 Mbps、每帧 ~35 KB，而背压阈值 256 KB —— 积压约 7 帧就触发，
  所以这是日常路径而非边角情况。现在按 `session.format.kind` 分别用
  `findBoundary` / `lastBoundary` 对齐。自测补 4 条（此前这两个 helper
  **没有任何覆盖**，缺陷才漏了过去）。

- **H.264 画面全黑（Android 实测）**：两个叠加的 bug，都会让解码器一帧都出不来。
  1. `codecStringFromSps` 忘了跳过起始码，从 `nal[1..3]` 读到的是 `00 00 01`，
     算出无效的 `avc1.000001`。Chrome 判为 "Unknown or ambiguous codec name."
     并**异步**把解码器置为 closed，于是每次 `decode()` 都抛
     `Cannot call 'decode' on a closed codec` —— 就是面板上那条报错。
     修正后为 `avc1.640032`。
  2. 参数集（SPS/PPS）单独成 chunk 喂给解码器时会被丢弃，整段流解不出帧
     **且不报错**。实测对比：独立喂 → 0 帧；拼进关键帧 → 1338 帧。
     现在缓存参数集，只在关键帧处拼接。
  另外：解码器崩溃后改为**用缓存的 codec 立即重建**（实测整段流只有一个 SPS，
  等下一个 SPS 永远等不到 → 画面永久卡死）。

  实测证据：用出货代码解真实抓取的 369KB 流 → **2991 帧 / 0 报错**。
  自测新增 6 条用例，直接从 `client.js` 源码抽函数求值（不是手抄副本），
  含真机 SPS 字节的回归断言。

- **面板没有任何入口**：tab 类型是"页类型"（不声明 `patterns`），只能被
  `openTab(kind)` 显式打开，而此前没注册任何入口 —— 面板注册成功却没人能打开。
  现在注册一条 `guide` 入口，在右侧边栏「开始」页出现「移动设备」胶囊。
  自测用桩 loader 求值 `lib/client.js`，直接断言注册出去的定义
  （含快捷键校验、blocked/handled 两条分支、以及宿主未提供 `shortcuts`
  时的优雅降级）。

- **工具栏按钮看起来不像按钮、也偏小**：原先自绘 26px 方块 + 1px 边框、无 hover 填充。
  改用平台 seed 模块 `@deepseek-ai/dsh-client-ui-primitives` 的官方
  `Button`（`size="sm"` = 28px、`variant="ghost"` 自带 hover 填充、focus ring、
  disabled 透明度）与 `Tooltip`，图标也从 "⌂/▢/◯" 字符换成官方规格的 SVG
  （字符的字重与基线跟旁边图标对不齐）。
- **设备下拉左右间距不对称**：原生 `<select>` 的下拉箭头会吃掉右侧内边距
  （左 8px / 右 0）。现在 `appearance: none` 关掉原生箭头，右侧自绘官方 chevron，
  左右视觉一致。保留 `<select>` 本身是为了键盘与无障碍。
- **tab 标签里的手机图标比旁边的文件夹/地球小一圈**：根因不是 `size`，
  而是官方对同一图形有**两套留白比例** —— guide artwork 占 viewBox 56.4%，
  tab 图标占 76.1%。同样 16px 下按 guide 比例只画出 9.0px，而官方是 12.2px。
  现在 `MobileArtwork` 按场合切换（`dense`），实测渲染高度 12.18px，与官方一致。
  同时去掉标签图标多余的 `margin-right`（dockkit 的 `.tabTitle` 已有 `gap:5px`，
  叠加会变成 9px，官方「文件」是 5px）。

### 新增

- **tab 标签图标**：注册 `sidebar.right.pane.tab.title`，标签上显示手机图标 + 标题
  （官方 files/browser/terminal 都注册了这个 seat）。图标跟随标签前景色
  （`currentColor`），与官方 `IconGlobeOutlineRegular` 一致，暗色主题下不会突兀。
- **快捷键**：`⌘⇧M`（桌面）/ `⌘⌥M`（浏览器）打开移动设备面板。
  键位与 DSH 自带的 8 条绑定无冲突，桌面端刻意避开 `⌘M`
  （macOS 系统「最小化」占用，原生菜单会先吃掉）。
  可在 **设置 → 快捷键** 里改。
- **入口图标**：自绘一幅手机 artwork，颜色（`#539CFA`）与尺寸契约
  （`viewBox 0 0 36 36`、默认 36、`aria-hidden`）与官方
  `GuideArtworkBrowser` 一致，纵向边缘逐像素对齐。
  官方没有手机图标（`primitives` 的 378 个 `Icon*` 里没有 phone/mobile），
  所以自绘而不是去引入第三方图标集。

### 说明

- 自测新增 4 条外观用例（按钮尺寸与变体、下拉内边距对称、标签图标不重复加间距、
  图标 aria-label），并把图标的填充比例与描边宽度改成断言「有效值」而非写死的常数。
- `shortcuts` / `sidebarRight` 都是**可选**注入：宿主没提供时插件其余部分照常工作，
  面板仍从「开始」页入口打开，只是没有快捷键与徽标。
  `@deepseek-ai/dsh-client-ui-primitives` 则**不需要**注入声明 —— 它是 web shell 的
  平台 seed 模块，永远可 require（官方 terminal 插件同样这么用）。

### 已知副作用（上游行为，非本插件 bug）

- 「开始」页的副标题会消失。DSH 有 `MAX_DESCRIBED_ENTRIES = 4`：胶囊超过 4 个，
  上游关掉**所有**胶囊的副标题（不是只关第 5 个）。官方 3 个 + `dsh-context` 1 个
  已经是 4 个，本插件必然是第 5 个。已确认接受该代价以换取入口；
  要恢复副标题只能把入口挪到 `conversation.session.header.utilities`。

## [0.1.0] - 2026-10-12

首个版本：把 mobilecli 封装成 DSH 右侧边栏的移动设备面板。

### 新增

- **右侧边栏面板**（`ctx.sidebarRightTabs` + `sidebar.right.pane.tab`）
  - 实时画面：Android 走 AVC/H.264（实测 104fps），iOS 模拟器走 MJPEG（实测 131fps）
  - 画面上直接点击/拖拽，等比例换算回设备坐标
  - 工具栏：主屏幕 / 返回 / 旋转 / 重连 / 外观切换
  - 状态栏显示流格式与设备信息

- **16 个模型工具**
  - 设备：`mobile_devices`、`mobile_boot`
  - 观察：`mobile_ui_tree`、`mobile_screenshot`、`mobile_flutter_tree`
  - 交互：`mobile_tap`、`mobile_tap_element`、`mobile_swipe`、`mobile_type_text`、`mobile_press_button`
  - 应用：`mobile_list_apps`、`mobile_launch_app`
  - OCR 兜底：`mobile_find_text`、`mobile_tap_text`、`mobile_wait_for`
  - 诊断：`mobile_logs`

- **打包并注册 mobilecli 自带的 skill**：上游的 `SKILL.md` 与 `reference.md` 原样打进包，
  加载时剥离 frontmatter 后注册，不需要用户自己往 `.agents/` 抄

- **流路由**：`grant` / `stream` / `devices` / `switch-device` / `control` / `device-action` / `status`

- **安全模型**：HMAC-SHA256 签名 capability（10 分钟过期、绑定设备）
  + loopback 传输层围栏（含 DNS rebinding 防护）
  + 可配置的 `trustedAuthorities`（反向代理场景）

- **单流多播**：一个设备一条流，多个消费者共享；空闲 5 分钟自停；崩溃自动重启（带退避）

### 说明

- **零运行时依赖**：`react` 用宿主那份；客户端单文件、无构建步骤
- **流格式从首块字节嗅探**：因为实测 iOS 模拟器上 `--format avc` 会静默降级成 MJPEG，
  相信请求参数会给出错误的 `content-type`，前端必然黑屏
- **UI 树递归展平**：mobilecli 返回嵌套树，直接读顶层实测只有 0 个元素，展平后 92 个

### 已知边界

- mobilecli 会独占设备的 UiAutomation，导致 `uiautomator dump` / Appium 不可用
  （实测确认；`mobilecli daemon stop` 后恢复）。进程内的 Flutter 测试不受影响
- mobilecli 的 `--fps` 参数当前不生效（请求 15 / 30 都得到 ~104fps）
- iOS 真机的 Flutter render tree 支持未验证（已知实现在模拟器路径上）
- Flutter render tree 需要 debug 构建（JVMTI 只能 attach 可调试应用）

[未发布]: https://github.com/j62268781-alt/dsh-sidebar-mobile/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/j62268781-alt/dsh-sidebar-mobile/releases/tag/v0.1.0
