# 变更日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)，
变更记录格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

一轮针对「清晰度 / 流畅 / 响应」的实测驱动优化。所有数字都来自同一台一加 12
（Android 16 / 1080×2376）上的连续横滑 6 秒实测，不是估算。

一句话结论：侧边栏画布只有 **630×1400 物理像素**，却一直拉 1080×2376 的流 ——
**2.9 倍过采样**，多出来的像素在浏览器里被降采样丢掉，纯属白解码。

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 编码分辨率 | 1080×2376 | 628×1384 |
| 每像素比特 | 0.027 | 0.048（+79%）|
| 解码负载 | 260 Mpx/s | 89 Mpx/s（−66%）|
| 码率 | 7.00 Mbps | 4.29 Mbps |
| 点击响应 | 166 ms（CLI 兜底）| 19.8 ms（RPC）|

### 新增

- **按面板像素自动决定取流分辨率**（`stream.defaultScale: 0`，出厂值）。
  客户端把画布物理像素宽（`preferredWidth`）随 `/grant` 上报，Host 用
  `scale = clamp(画布宽 / 设备宽, 0.35, 1)` 反推，再把 `--scale` 交给 mobilecli。
  实测 0.583 正对 630 物理宽；再降到 0.5 开始欠采样发糊。

  三条回落路径都收敛到「不缩放」（查不到设备尺寸 / 客户端没上报 / 用户配了固定
  value），保证这个优化不会让画面变得更差。

- **帧像素 ↔ 设备像素的坐标换算**。客户端发的指针坐标在**帧**坐标系里（因为
  画面可能被缩放），Host 在 `/control` 里除以 scale 还原成设备坐标。只在
  `/control` 做 —— Agent 工具传的已经是设备坐标，在通用路径缩放会让它们全点错。

- **daemon RPC 通道自愈**。daemon 空闲 30 分钟会自退，旧实现一次 `ECONNREFUSED`
  就把整场会话永久降级到 CLI（166ms vs 19.8ms，8.4 倍），而 `reset()` 在生产
  代码里一次都没被调用过。现在按 5s→15s→60s 退避、用实测 0.7ms 的
  `daemon.status` 探测，恢复即复用；CLI 兜底成功后也会立刻恢复。

- **`prewarm()`**：面板打开时顺手探一次，消掉「第一次点击必然走 CLI」。

- **`--bitrate 0` = 按 scale 自动推导**（出厂值）。满分辨率给 10 Mbps
  （实测 8 Mbps 只能跑到 7.10 Mbps、已贴上限；10 Mbps 实测 8.72 Mbps、
  比特数 +23%），缩放后按 `scale²` 折算、下限 5 Mbps。

### 变更

- **绘制搬进 `requestAnimationFrame`**，上限 30 → **60 FPS**。原来在解码回调里
  直接画，每次操作要白等约半周期（17ms）；现在解码只存最新帧，rAF 里画，
  60/120/144Hz 屏实测分别 59.8/60/72fps、帧间隔标准差 0。
- **用 ResizeObserver 缓存舞台尺寸**，去掉每绘制帧 `getComputedStyle` +
  `clientWidth` 的强制同步布局。
- **缓存 2D 上下文**并关掉 `alpha`。
- **`/status` 与设备枚举降频**：`devices` CLI 实测 356ms，每 5 秒一次等于每分钟
  12 次、7% CPU，还会和 tap/swipe 抢 adb。改为 15 秒 TTL + `staleOk`，最多
  4 次/分钟且永不阻塞调用方（掉线最多迟 15 秒发现）。
- **背压加迟滞**：256KB 进入丢弃态、降到 64KB 才恢复。原来「一找到帧边界就恢复」
  会让缓冲排不空，MJPEG 稳态延迟被钉在 ~0.26 秒。

### 修复

- **spawn 失败导致永久黑屏 300 秒**。`spawn` 失败只发 `'error'` 不发 `'exit'`
  （ENOENT/EACCES/EMFILE），旧代码让会话永远停在「正在跑」：画面黑屏、
  `/status` 仍报 `streaming: true`、要等 300 秒空闲自停才恢复。
- **`imageSmoothingQuality` 按缩放比选择**。实测 Chrome/ANGLE Metal 下 `low` 与
  `high` 输出**逐字节相同**，但 630×1386 一次 drawImage `low` 2.2ms、
  `high` 12.2ms（4–6 倍）。所以缩放比 ≥1.5 用 `low`，近 1:1（scale 生效后的
  常态）才用 `high`。
- 删掉每 30 帧一次的 `report("playing", {frames})`：`frames` 全代码无人消费，
  等于 4Hz 整面板重渲染。

### 说明

- **`--fps` 依然不生效**（复测 101–103fps，传什么都一样），限流只能在客户端做。
- **`--bitrate` 是软上限**：设 4 Mbps 实测仍出 6.79 Mbps，不能当限流用。
- **scale 变化不重启正在跑的流**（拖窗口会连续变，重启 = 再黑屏一段）。坐标始终
  按会话真实 scale 换算，不会点偏；新分辨率在下一个会话生效。

## [0.1.0] - 2026-10-15

首个版本：把 mobilecli 封装成 DSH 右侧边栏的移动设备面板。

> **这是首次发布** —— npm 上从未发过更早的版本，git 也没有更早的 tag。
> 下面的记录覆盖整个开发期：工具面从 16 个收敛到 **11 个**，并修掉了两个
> 影响**所有**工具输出的 bug。所以「新增 / 变更 / 修复」合在一起才是这个
> 版本的真实内容，而不是只列最后一刀。

### 新增

- **`mobile_open_panel`：让模型能把侧边栏的移动设备面板打开给用户看。**

  用途很具体：当你需要用户**亲眼看**手机屏幕时（"你点一下这个弹窗"、"确认一下
  这一屏对不对"），把画面推到他面前，而不是让他自己去翻侧边栏。

  **这个工具不是给模型读界面用的** —— 模型看不到这个面板（它在用户的浏览器里，
  不在模型的上下文里）。要读界面仍然用 `mobile_ui_tree` / `mobile_screenshot`。
  描述里把这一点写死了，避免模型误用。

  #### 为什么要绕这么一圈

  工具跑在 **Host 进程**里，侧边栏在 **浏览器**里。DSH 没有给客户端插件一条
  通用的 host→client 推送通道（SSE/WebSocket 只存在于 ACP 那条线），而
  `ctx.sidebarRight.openTab` 是**客户端** API。所以只能由客户端主动来问。

  做法是**长轮询**，两个设计点都是必需的：

  | 决定 | 不这样做会怎样 |
  |---|---|
  | 轮询挂在 **`apply(ctx)`**（插件加载期），不是面板组件里 | 面板组件的 `useEffect` 只在挂载后才跑 —— 那就只有面板**已经打开**时才轮询，而"打开一个还没打开的面板"永远等不到人来问。功能自相矛盾。 |
  | **长轮询**而不是定频心跳 | 定频心跳会引入一个 5 秒量级的固定延迟，且空闲时一直在发请求。长轮询空闲时只挂着一条连接、零重复请求，请求一到立刻返回。 |

  宿主最多挂 20s 后正常收尾，客户端再挂上。请求号单调递增，客户端记住上次处理
  过的号即可幂等。**客户端打开后会回执**，所以工具返回的 `opened: true` 是确认过
  的，不是"请求已发出"；没人应答时如实返回 `opened: false` 并说明原因 —— 不对
  用户说"已经打开了"而屏幕上一片空白。

  打开动作走 `ctx.sidebarRight.openTab("mobile")`（与官方 browser 插件同一入口），
  它的默认行为是"已有同 kind 的 tab 就聚焦它，没有就建一个"，所以"打开"和
  "已经在则切过去"是同一句话。**不能用 `openTabFromTarget`** —— 那个需要一个
  DOM 元素，而模型发起的打开没有元素可给。

  工具面 10 → 11，schema 常驻 910 → **964 tokens/轮**。

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

- **右侧边栏面板**（`ctx.sidebarRightTabs` + `sidebar.right.pane.tab`）
  - 实时画面：Android 走 AVC/H.264（实测 104fps），iOS 模拟器走 MJPEG（实测 131fps）
  - 画面上直接点击/拖拽，等比例换算回设备坐标
  - 工具栏：主屏幕 / 返回 / 旋转 / 重连 / 外观切换
  - 状态栏显示流格式与设备信息

- **11 个模型工具**（开发期从 16 个收敛到 11 个，收敛过程见下面「变更」）
  - 设备：`mobile_devices`、`mobile_boot`
  - 观察：`mobile_ui_tree`、`mobile_screenshot`
  - 交互：`mobile_tap_element`
  - 应用：`mobile_list_apps`
  - OCR 兜底：`mobile_find_text`、`mobile_tap_text`、`mobile_wait_for`
  - 诊断：`mobile_logs`
  - 面板：`mobile_open_panel`

- **打包并注册 mobilecli 自带的 skill**：上游的 `SKILL.md` 与 `reference.md` 原样打进包，
  加载时剥离 frontmatter 后注册，不需要用户自己往 `.agents/` 抄

- **流路由**：`grant` / `stream` / `devices` / `switch-device` / `control` / `device-action` / `status`

- **安全模型**：HMAC-SHA256 签名 capability（10 分钟过期、绑定设备）
  + loopback 传输层围栏（含 DNS rebinding 防护）
  + 可配置的 `trustedAuthorities`（反向代理场景）

- **单流多播**：一个设备一条流，多个消费者共享；空闲 5 分钟自停；崩溃自动重启（带退避）

### 变更

- **删除 `mobile_flutter_tree`**：它**与 `mobile_ui_tree` 完全重复**，且描述不实。

  两者的 `execute` 调的是同一个函数（`dumpUiElements` → `mobilecli dump ui`），
  唯一差别是它多一层"结果为空时给友好报错"。而它的描述却写着"绕过无障碍投影，
  **直连 Dart VM Service**" —— 它从未连过任何 VM Service。

  实测对一台真实的 debug Flutter 应用（`com.dycjr.jg.inner`，APK 有
  `assets/flutter_assets/`、`flags=[ DEBUGGABLE ]`、无 `libapp.so`）：

  ```
  mobilecli dump ui --format json  →  69 个节点，全部 android.*
    32 个是 systemui 状态栏（时间/网速/wifi/电池），与应用无关
    应用窗口下全是匿名 View/ImageView —— 只有 rect，没有 text/identifier
  ```

  也就是说它给不出描述承诺的任何东西。**一个描述骗人的工具比没有这个工具更糟**
  —— agent 会以为读到了 Flutter 树并据此下结论。

  顺带纠正一个更容易被误判的点：**这不是 Flutter 不可测，而是 Flutter 的语义树
  默认根本不生成**。实测关掉读屏时它自己会回：

  > Semantics not generated … the framework only generates semantics when
  > asked to do so by the platform. Usually, platforms only ask for semantics
  > when assistive technologies (like screen readers) are running.

  实测过"开 TalkBack 再读 a11y 树"这条替代路线，**不推荐**：启用后 TalkBack
  自己的 7 页设置向导会抢占前台（拿到的文字全是 `关闭 TalkBack` / `欢迎使用
  TalkBack` 之类），而且它需要改变用户设备的无障碍状态、让手机开始朗读、把触控
  变成"单击选中双击激活"。作为产品能力不可接受。

  真读 Flutter widget 树的正确路径是 **Dart VM Service** 或 **Patrol /
  `integration_test`**，两条路线的完整实测（协议细节、踩坑、阻塞项）见
  [docs/FLUTTER-TREE-RESEARCH.md](docs/FLUTTER-TREE-RESEARCH.md)。

  名字保留在 `REMOVED_TOOL_NAMES`（本仓库惯例），便于分辨"插件删了它"和
  "名字打错了"。**工具面 11 → 10，schema 常驻 1034 → 910 tokens/轮**
  （实测：用桩宿主直接加载 `tools.js` 量 `header.tools`）。

  一并清掉了 README 里**同样不实的营销文案**（"能读 Flutter 的真实 widget 树：
  直连 Dart VM Service"、已知边界里的两条 Flutter 说明）与 `docs/market-entry.yml`
  的中英文描述 —— 那个不实能力原先一路渗透到了对外的市场文案里。

- **客户端改用 JSX + 独立样式文件，`lib/` 按职责分目录**（用户反馈
  "用的 h 这种让人看起来代码好奇怪"、"样式文件和布局文件应该要做区分"）。

  **先说硬约束**：DSH 把 client bundle 当经典脚本求值，不做任何转译，
  运行时有 bundle purity gate —— 所以**不编译就既不能写 JSX，也不能拆文件**
  （相对 `require` 只对打包器产出的 chunk 有效）。DSH 自己的客户端插件
  同样是打包出来的（`tsdown.client.ts`）。

  因此新增构建步骤，但刻意做成最小的：

  | | 位置 |
  |---|---|
  | 布局与逻辑源码（JSX） | `src/client/index.jsx` |
  | 样式源码（CSS） | `src/client/styles.css` |
  | 构建产物（**已提交**） | `lib/client.js` |

  三个决定：

  · **只转译、不打包**（esbuild 的 `transform`）。产物必须保留
    `__ModuleLoader__.load({ factory(require) })` 外壳，`require("react")`
    也得留着 —— react 由宿主注入，打进产物会违反 purity 且出现两份 React。
  · **`jsxFactory: "h"`**：JSX 编译回 `h(...)`，与改造前同构，既有断言测试
    继续有效（改成自动运行时 `_jsx(...)` 会让十几处断言重写）。
  · **产物提交进仓库**：本插件以 git 依赖安装，提交产物让安装方**完全不需要
    工具链**（esbuild 只是 devDependency）。

  产物进仓库会漂移（改了 src 忘了构建，安装方拿到的还是旧文件，极难察觉），
  所以 `verify` 里加了 `build:check`：重新构建并与提交的产物逐字节比对。

  两个构建细节是踩出来的：

  · **`charset: "utf8"` 必须显式设** —— esbuild 默认 `ascii`，会把中文转义成
    `\uXXXX`，产物变成一屏 `\u771F\u673A`，没法 review（实测确认）。
  · 剥掉 esbuild 给每个元素加的 `/* @__PURE__ */` 标注 —— 那是给下游打包器
    摇树用的，本插件不打包，留着只弄脏提交的文件。

  `lib/` 重组为按职责分目录：`device/`（二进制解析、CLI、daemon RPC、adb 体检）、
  `stream/`（令牌、会话池、路由）、`agent/`（工具、skill、宿主契约转发层）。
  根下只留 `client.js`，一眼可见"它是唯一生成的"。

  ⚠️ 重组时 `lib/skills.js` 深了一层，`SKILL_DIR` 的相对路径少了一级，
  **导致全部 skill 加载失败** —— 被自测当场拦下。已在代码里写明这条路径与
  文件层级强耦合。

  自测 134 → 138（新增 4 条守新约定：源码不许退回手写 `h(...)`、样式必须待在
  `styles.css`、构建必须设 utf8 与 jsxFactory=h、`lib/` 根下只许有产物）。

- **交互指令改走 daemon 的 unix socket，延迟降低约 90%**：CLI 路径每条指令都要
  新起一个 node 进程（mobilecli 是 `#!/usr/bin/env node`），实测固定开销约 66ms。
  改用 daemon socket 的 JSON-RPC 后：

  | 操作 | 改前（CLI） | 改后（RPC） |
  |---|---|---|
  | `tap` | 104.2 ms | **7.3 ms** |
  | `swipe --duration 300` | 411 ms | 314.9 ms |
  | （其中固定开销） | 111 ms | **14 ms** |

  **关键：这条路径不需要 `server start`。** mobilecli 的 daemon 本来就在运行
  （CLI 每条命令都会把它拉起来），它的 socket 直接吃 JSON-RPC —— 所以不新增
  进程、不占端口、没有会话过期，正好绕开 ARCHITECTURE 里「不用 server 模式」
  的三条理由。

  协议细节（都是实测出来的）：传输是 **newline-delimited JSON 而非 HTTP**
  （`curl --unix-socket` 会被拒）；**一请求一连接**（daemon 回完就主动关闭，
  连发 3 个只回 1 个）；参数是**独立字段**而非 CLI 的逗号串。

  ⚠️ **`rotate` 仍走 CLI** —— daemon 不暴露 orientation（实测多个候选方法名
  全部 `method not found`）。CLI 始终是兜底：daemon 没起、版本不支持、
  动作无 RPC 实现时都回退，功能不丢。连接层失败会标记通道不可用（不逐次
  白等超时），但业务失败不标记（否则一次设备错误就永久降级）。

  配置 `useDaemonRpc: false` 可强制全部走 CLI。自测 115 → 127。

- **工具面从 16 个收到 11 个，省 453 tokens/轮**：删掉 5 个薄包装
  （`mobile_tap` / `mobile_swipe` / `mobile_press_button` / `mobile_type_text` /
  `mobile_launch_app`）——它们只是 `runJson(...)` 加一句 `return`，没有任何加工，
  而 agent 本来就有 shell（`dsh-tool-bash` 在 dsh-base 里，恒可用），
  直接跑等价命令即可。

  按宿主自己的计价公式（`dsh-token-meter`：`ceil(chars/4)+4`）实测：

  | | tokens/轮 |
  |---|---|
  | 改前 16 个 | 1487 |
  | 改后 11 个 | **1034** |
  | 省 | **453** |

  ⚠️ **知识没跟着删**。被删命令的坑（坐标是物理像素、`io swipe` 必须传
  `--duration` 否则默认 ~1000ms 慢动作、输入前必须先聚焦、`io button` 的键名、
  启动应用前先列应用、非 ASCII 无需 ADBKeyboard）已写进
  `skills/mobilecli/SKILL.md` 的「Driving the device from the shell」一节。
  被删的名字留在 `REMOVED_TOOL_NAMES`，便于分辨"插件删了它"和"名字打错了"。

- **收紧 skill 的触发描述（本次收益最大的一项）**：`description` + `whenToUse`
  会进每轮的工具面索引，而它们一旦诱导模型在本可直接调工具的场景去载入技能，
  代价是 **5137 tokens 的正文**（实测）——且正文载入后留在对话历史里，
  此后每轮重发。

  老版本写的是 "Use whenever a task involves operating or inspecting a mobile
  device"，几乎覆盖全部场景，而这些场景**已经有工具**。现在明确两件事：
  ① 只在工具做不到时用（录屏、pinch、剪贴板、文件传输、WebView、崩溃报告、
  安装/卸载、开机/关机、区域设置、远程设备、脚本化 mobilecli）；
  ② 明确列出"别为我载入"的场景（tap / swipe / 输入 / 按键 / 截图 / UI 树 /
  列应用 / 启动应用 / 日志）。

  实测这笔误触发是工具瘦身收益的 **~15 倍**（5137 vs 453），所以先修它。

### 修复

- **所有 `mobile_*` 工具的输出都是错的 —— 根因是 `render` 少了一个参数。**

  这是一个**长期 bug**，也是"所有 mobile_* 工具返回空结果"那个一直没查明的
  现象的答案。

  DSH 的 `ToolOutputDefinition` 在**类型和调用点两处**都写死了两个参数：

  ```ts
  render(args: unknown, value: JsonValue): ContentBlock[]
  ```
  ```js
  const rawRender = output.render;
  rawRender(args, value)        // harness 里的实际调用
  ```

  而插件写的是 `renderJson(value)` —— 只收一个参数。于是 harness 传进来的
  **`args` 被当成了结果**。后果按工具有没有参数分成两种：

  | 工具 | harness 传的 args | 原先显示成 |
  |---|---|---|
  | 无参数的（`mobile_devices` / `mobile_open_panel`） | `{}` | **`{}`** |
  | 有参数的（其余 9 个） | 你刚传的入参 | **入参回显** |

  第二种比第一种更糟：它看起来像个正常结果，**不可疑**，所以没人发现。
  实测确认过 —— 传入 `{device:"784999f3"}`、返回 `{opened:true,waitedMs:3}`，
  修复前渲染出的是 `{"device":"784999f3"}`。

  修法就是补上第一个参数并显式忽略：`renderJson(_args, value)`。注意 DSH 自己
  的工具正是这么写的（`render: (_args, value) => [...]`），本插件是抄漏了参数。

  新增护栏测试「render 必须按 (args, value) 两参签名」，钉住三件事：参数必须
  是两个、第一个必须以下划线开头、序列化的必须是第二个。已复验改回单参会被抓住。

  测试 146 → 147。

- **离线设备「看得到却选不中」（用户报告）**：面板的设备列表来自 `#status`
  （`includeOffline: true`，所以关着的模拟器**看得见**），但点它时走
  `#grant`（用默认值，**不含**离线）→ 查不到 → 回 `未找到设备：<id>`。
  用户视角就是"列表里明明有，点了却说没有"。

  两处列表用了不同的过滤条件，属于自相矛盾。`#grant` 现在也用
  `includeOffline: true`。

  另外**选中离线模拟器会顺手把它启动起来** —— 面板是可视化入口，用户在
  下拉里点了一台关着的模拟器，预期就是"用它"，报一句"设备离线"然后把
  启动的负担推回给用户是不合理的。

  ⚠️ 两条边界：
  · 只有 `simulator` / `emulator` 才 boot。**真机离线通常是没插线或没开
    USB 调试**，boot 没有意义，交给状态轮询反映。
  · boot 失败**不影响选中**，错误经 `bootError` 单独返回并显示 ——
    否则一次启动失败会让用户连选都选不中。

  面板侧配套：启动中的状态栏提示（琥珀色呼吸点 + "正在启动设备…"）——
  模拟器冷启动可达数分钟，不说明的话看起来像卡死。超时给 5 分钟
  （与 `mobile_boot` 工具一致），短了会把"正在启动"误报成失败。

  自测 131 → 134。

- **设备下拉分不出模拟器与真机（用户报告）**：同时插着「一加 12」与
  「iPhone 17 Pro」时，下拉里只显示名字，**完全看不出哪个是模拟器**。

  设备数据里本来就有 `type` 字段（mobilecli 的 `--type` 帮助原文：
  `real or simulator/emulator`），只是面板没用它。现在：

  - 选项文字带类型后缀：`一加 12 · 真机` / `iPhone 17 Pro · 模拟器`
  - **多种类型时用 `<optgroup>` 分组**，两类成为独立的视觉区块
  - 只有一种类型时不加分组标题（那时只是多余层级），但**保留后缀**，
    照样能分辨
  - 分组内不再重复后缀（否则「真机 / 一加 12 · 真机」很啰嗦）

  顺带修掉一处自相矛盾：**状态栏原先显示裸的英文 `active.type`**
  （`android · real · 16`），与下拉的中文说法不一致。现在两处共用
  同一个 `deviceKindLabel()` 映射。

  ⚠️ 认不出的类型值**原样返回**而不是兜底成「真机」—— 猜错会让用户以为
  手里是台真机。`emulator`（Android 模拟器上报的值）也一并认。

  自测 127 → 131。

- **流中断后画面永久死亡（用户报告"滚动的时候画面直接死了"）**：两个叠加的缺陷，
  都不在解码器本身。

  ① **Host 崩溃后浏览器察觉不到**。Host 侧流进程崩溃会自己重启
     （`#scheduleRestart`），但**浏览器这条 HTTP 响应不会被关闭** ——
     它只是不再有新数据。于是 `reader.read()` 永远挂着，既不 `done`
     也不 `error`。

  ② **客户端根本没有重连**。一次 `run()` 结束就 `report("ended")` 返回，
     而 `useEffect` 的依赖（`streamUrl`）没变，所以**再也不会重新取流**。

  现在加了停流看门狗（3 秒没有任何字节就主动掐断）+ 自动重连
  （退避 1s→8s，收到数据即复位）。看门狗只监控"有没有数据"而不是帧率 ——
  静止画面时编码器可能只发很稀疏的帧，按帧率判断会误杀。

- **退避会单向累积到 30s 且永不恢复**：`crashCount` 原先只在**空闲自停**时
  归零，于是它只增不减。实测后果：反复几次崩溃（网络抖动、设备忙碌）就能把
  重连退避推到 30s 上限，此后即使流跑得很好，下次崩溃也要干等 30s ——
  表现为"卡一下之后再也回不来"，且越用越糟。

  现在拿到**第一块数据**就清零 —— 用"首块到达"而不是"进程还活着"作为成功
  信号，因为进程起来立刻退出（设备端 agent 没起来时只输出 `Error:`）
  不该算成功，否则会退化成无退避的快速重启循环。

  实测：隔离环境下用真实 `StreamSession` + 真实 `StreamRoutes` 验证，
  消费保持订阅时杀进程 → Host 重启 → **同一条 HTTP 响应继续收到数据**
  （8 → 15 字节）。

- **点击/滑动有 300+ms 延迟（体感"不跟手"）**：交互热路径上挂着一个设备预检查
  —— 每次点击都先 `listDevices({includeOffline:true})` 复核设备还在不在。
  实测分解（一加 12 真机）：

  | 步骤 | 中位数 |
  |---|---|
  | `mobilecli devices --include-offline` | **328 ms** |
  | `mobilecli io tap` | **103 ms** |
  | 合计（原实现） | **431 ms** |

  即 **76% 的点击延迟花在这个预检查上**。对运行中的服务实测更夸张：
  设备缓存（1.5s TTL）一过期，单次 tap 就要 **576 / 516 ms**。

  现在 `#requireActiveDevice()` 同步返回记住的 id，不做存在性复核：
  设备真掉线时 `mobilecli` 自己会报
  `error finding device: device not found: <id>`（实测），措辞一样清楚；
  而"离线"本就有更权威的信号 —— 5 秒状态轮询会更新设备列表、面板据此禁用按钮。
  那个预检查只买到"早 328ms 失败"，代价是让**几乎每次正常操作**都慢 328ms。

  用真实 `StreamRoutes` 驱动验证：**431 → 105 ms**，调用序列只剩一次 `io tap`。
  自测补 3 条（热路径不得出现 `listDevices`、`device-action` 同理、
  以及 `activeDeviceId` 为 null 时仍要 409），97 → 100。

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

### 说明

- 自测新增 4 条外观用例（按钮尺寸与变体、下拉内边距对称、标签图标不重复加间距、
  图标 aria-label），并把图标的填充比例与描边宽度改成断言「有效值」而非写死的常数。

- `shortcuts` / `sidebarRight` 都是**可选**注入：宿主没提供时插件其余部分照常工作，
  面板仍从「开始」页入口打开，只是没有快捷键与徽标。
  `@deepseek-ai/dsh-client-ui-primitives` 则**不需要**注入声明 —— 它是 web shell 的
  平台 seed 模块，永远可 require（官方 terminal 插件同样这么用）。

- **零运行时依赖**：`react` 用宿主那份。客户端源码是 JSX + 独立样式文件，但**构建产物 `lib/client.js` 已提交进仓库** —— 安装方无需任何工具链，加载的就是那份产物

- **流格式从首块字节嗅探**：因为实测 iOS 模拟器上 `--format avc` 会静默降级成 MJPEG，
  相信请求参数会给出错误的 `content-type`，前端必然黑屏

- **UI 树递归展平**：mobilecli 返回嵌套树，直接读顶层实测只有 0 个元素，展平后 92 个

### 已知边界

- mobilecli 会独占设备的 UiAutomation，导致 `uiautomator dump` / Appium 不可用
  （实测确认；`mobilecli daemon stop` 后恢复）。进程内的 Flutter 测试不受影响

- mobilecli 的 `--fps` 参数当前不生效（请求 15 / 30 都得到 ~104fps）

### 已知副作用（上游行为，非本插件 bug）

- 「开始」页的副标题会消失。DSH 有 `MAX_DESCRIBED_ENTRIES = 4`：胶囊超过 4 个，
  上游关掉**所有**胶囊的副标题（不是只关第 5 个）。官方 3 个 + `dsh-context` 1 个
  已经是 4 个，本插件必然是第 5 个。已确认接受该代价以换取入口；
  要恢复副标题只能把入口挪到 `conversation.session.header.utilities`。

[0.1.0]: https://github.com/j62268781-alt/dsh-sidebar-mobile/releases/tag/v0.1.0
