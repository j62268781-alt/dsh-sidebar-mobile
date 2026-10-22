# 架构与关键取舍

面向要改这个插件的人。用户只需要看 [README](../README.md)。

## 分层

```
浏览器（右侧边栏 tab）
  │  只经 DSH 自己的 web 源，从不接触 mobilecli 的端口
  ▼
lib/client.js            tab 类型 + 正文组件；两条渲染路径（H.264 / MJPEG）
  │  ⚠️ 这是**构建产物**（源码在 src/client/，见「为什么客户端要构建」）
  │  fetch POST /_dsh/dsh-sidebar-mobile/{grant,control,device-action,status}
  │  <img|canvas> GET …/stream/<token>
  ▼
lib/stream/routes.js     路由分发、body 解析、错误收敛
  ├── lib/stream/access.js    签名令牌 + loopback 围栏
  └── lib/stream/session.js   单流多播、空闲自停、崩溃重启
        │
        ▼
lib/device/mobilecli.js  二进制解析、execFile 调用、spawn 流进程
        ├── lib/device/android-toolchain.js  adb 体检
        └── lib/device/daemon-rpc.js         daemon socket 的 JSON-RPC（交互加速）
        │
        ▼
mobilecli（Go 二进制）
  │  adb / simctl / usbmux / on-device agent
  ▼
设备
```

`lib/` 按职责分目录，同类放在一起：

| 目录 | 放什么 |
|---|---|
| `lib/`（根） | 仅 `client.js` —— 唯一一个构建产物，刻意不放进子目录，让"它是生成的"一眼可见 |
| `lib/device/` | 怎么跟设备说话：二进制解析、CLI 调用、daemon RPC、adb 体检 |
| `lib/stream/` | 视频流的整条链路：令牌、会话池、HTTP 路由 |
| `lib/agent/` | 给模型的那一面：工具定义、skill 注册、宿主契约转发层 |

Host 侧的 agent 模块：

- `lib/agent/tools.js` —— 11 个模型工具，全部经 `defineTool` 注册
- `lib/agent/skills.js` —— 把打包的 mobilecli playbook 注册给模型

`index.js` 负责接线，并用 `ctx.effect` 保证卸载时全部注销。

## 关键取舍

### 为什么用 CLI 而不是 mobilecli 的 server 模式

mobilecli 有 `server start` + JSON-RPC，返回 `sessionUrl` 供二次连接。本插件没用它，理由：

- server 模式要多管一个常驻 HTTP 服务（端口占用、会话过期、二次清理）
- `screencapture` 写 stdout 的路径已被实测验证（Android 104fps / iOS 131fps）
- 少一层进程就少一类失败

代价是流格式无法从 API 声明得知，只能从首块字节嗅探——但这本来就是必需的（见下）。

### 为什么交互指令走 daemon socket 而不是 spawn CLI

上面的「不用 server 模式」只管**取流**（`screencapture` 走 stdout 是对的）。
但**交互指令**另有一条路，而且实测差距很大：

| | tap | swipe(300ms) |
|---|---|---|
| spawn CLI | 104.2 ms | 411 ms（固定开销 111ms）|
| daemon socket | **7.3 ms** | 314.9 ms（固定开销 14ms）|

差在**每条命令新起一个 node 进程**（该 POSIX 样本的 mobilecli 使用 `#!/usr/bin/env node`），实测约 66ms。Windows 上解析为原生可执行文件，启动开销不同；不能直接套用这组数字。

关键是：**这条路不需要 server 模式**。在支持的 POSIX 环境，mobilecli 的 daemon 本来就在运行（CLI 每条
命令都会把它拉起来，空闲 30 分钟自退），unix socket 直接吃 JSON-RPC。Windows 上
Node 访问 socket 可能收到 EACCES/EPERM，插件会停用 RPC 并回退 CLI，因此先按平台测量。

协议细节（都是实测出来的，写错任何一条都会静默变慢或失败）：

- 传输是 **newline-delimited JSON**（写一行 + `\n`），**不是 HTTP**。
  用 `curl --unix-socket` 会被拒（`Received HTTP/0.9 when not allowed`）。
- **一请求一连接**：daemon 回完响应就**主动关闭** socket。连发 3 个请求只回 1 个。
  所以每个请求新建连接 —— 约 7ms，仍远快于 CLI。不要试图复用连接（会 EPIPE）。
- 参数形状与 CLI **不同**：CLI 是逗号串（`540,1800,540,900`），
  RPC 是独立字段（`x1/y1/x2/y2`）。传逗号串报 `'x1' is required`。
- socket 路径 = `<MOBILECLI_HOME>/daemon.sock`。**必须与 CLI 用同一个 home**
  （插件里抽成 `mobilecliHome` 一个变量），否则两边连到不同 daemon。
- 权限天然收窄：socket 是 `srw-------`，只有本用户可连。

⚠️ **`rotate` 没有 RPC 实现**：daemon 不暴露 orientation（实测
`device.orientation(.get/.set)`、`device.rotate`、`device.setRotation` 等
全部 `method not found`），所以 `rpcForDeviceAction` 对它返回 null，
调用方回退 CLI。这是唯一一个仍走 CLI 的面板动作。

**CLI 始终是兜底**：daemon 没起（ENOENT）、版本不支持、某动作无 RPC 实现时
都回退，功能不丢。`DaemonRpc` 在**连接层**失败后会标记不可用，避免之后每次
交互都白等一次连接超时；但**业务失败**（设备不存在、手势被拒）不标记 ——
否则一次设备错误就会让整条快速通道永久降级。

配置 `useDaemonRpc: false` 可强制全部走 CLI（排查用）。

### 为什么从字节嗅探流格式，而不相信请求参数

实测：**iOS 模拟器上 `--format avc` 会静默降级成 MJPEG**，不报错、不警告。如果相信请求参数，就会给前端发 `content-type: video/h264`，而前端拿 H.264 解码器去解 JPEG——必然黑屏，且原因极难定位。

`sniffStreamFormat()` 因此只看字节：

- `00 00 01` / `00 00 00 01` 开头 → H.264 Annex B
- `--<boundary>` 开头 → MJPEG，boundary 从首行提取

### 为什么是单流多播

面板、截图卡片、模型工具会同时想要画面。各起一个 `screencapture` 进程会：

- 让设备端反复经历 agent 启停
- 在 USB 真机上争抢带宽（实测多流会显著降低各自帧率）

所以 `StreamSessionPool` 按 deviceId 复用会话，消费者订阅同一份字节。空闲 5 分钟自停——面板关掉后不该让设备一直编码。

**主动停止不被重启逻辑对抗**：`stop()` 先置 `stopping` 再杀进程，否则退出事件会把刚停掉的流又拉起来。

### 为什么 MJPEG 用 `<img>` 而 H.264 用 WebCodecs

`multipart/x-mixed-replace` 是**浏览器原生支持**的格式，`<img>` 直接渲染：零解码代码、自动分帧、自动重连。自己解 multipart 只会更慢更脆。

H.264 没有这种待遇，必须自己解。几个必要处理：

- **按起始码切访问单元，跨 chunk 的半个 NAL 必须留住**。TCP 分片不会体贴地在 NAL 边界断开；丢掉残段会导致持续花屏或解码器卡死。
- **`optimizeForLatency: true`**：实时画面要的是延迟，不是压缩率。不开这个解码器会缓冲若干帧再吐。

#### codec 字符串必须跳过起始码（真机踩过）

`splitAnnexB` **有意保留起始码**（annexb 模式要的就是带起始码的完整 NAL），所以从 SPS 推 `avc1.PPCCLL` 时必须先跳过它：

```
00 00 00 01 | 67 | 64 00 32
└─起始码──┘  │    └─PPCCLL─┘  → avc1.640032
             └─ NAL 头（低 5 位 = 7 = SPS）
```

写成 `nal[1..3]` 会读到**起始码本身**，得到 `avc1.000001`。Chrome 判为
`Unknown or ambiguous codec name.`，并**异步**把解码器置为 `closed`
（`configure()` 不抛同步异常，所以 try/catch 抓不到），之后每次 `decode()`
都抛 `Cannot call 'decode' on a closed codec` —— 表现为**画面全黑**。

#### 关键帧必须自带 SPS+PPS

实测（真实 Android 流，331 个 NAL，逐个策略跑 WebCodecs）：

| 喂法 | 解码结果 |
|---|---|
| SPS/PPS 当独立 chunk 喂 | **0 帧** |
| 完全跳过 SPS/PPS | **0 帧** |
| **SPS+PPS 拼在关键帧前面** | **1338 帧，零报错** ✅ |

解码器要的是"一个自带参数集的关键帧访问单元"。参数集单独成 chunk 时会被丢弃或让
解码器停在等待关键帧的状态，**整段流一帧都出不来，而且不报错** —— 比报错更难查。
所以缓存 SPS/PPS，只在关键帧处 `concatBytes(sps, pps, unit)`。

#### 崩了要靠缓存的 codec 重建，不能等下一个 SPS

实测 SPS 在整个流里**只出现一次**（Android 8 秒流）。解码器一旦 `closed`，
靠"等下一个 SPS 再配置"永远等不到，画面永久卡死。正确做法是记住
`activeCodec`，一发现 `decoder.state === "closed"` 就立刻重建，
并置 `needsKeyframe` 等下一个 IDR（实测 IDR 间隔 ~0.8s，肉眼几乎无感）。

### 为什么坐标用 getBoundingClientRect

`object-fit: contain` 在画面比例与容器不一致时会留黑边。按 CSS 声明尺寸换算出的坐标会**系统性偏移**——偏移量随容器尺寸变化，表现为"点 A 却点到 B"，很难复现。

正确做法是算出画面在容器内的实际显示矩形（`naturalWidth` × 缩放 + 居中偏移），并且**落在黑边上的指针事件直接忽略**（那不是对设备的操作）。

滑动与点击的区分：位移超过屏幕宽的 2% 判为滑动，否则为点击。阈值太小会把手指抖动误判成滑动。

### canvas 尺寸：必须由「帧的宽高比」决定（真机踩过）

曾经把 `canvas` 的尺寸写成「读它自己的 `getBoundingClientRect()` × DPR」，
结果**画面被压成一条横向小条**（用户截图确认）。原因是循环依赖：

```
<canvas> 没设 CSS 尺寸时默认 300×150（宽高比 2.0）
   ↓
.mbm-media 只有 max-width/max-height → 元素按 300×150 排版
   ↓
读到 300×150 → 后备存储设成 600×300 → 显示仍是 300×150（max-* 之下不变）
   ↓
自洽地卡在 2.0 —— 与设备的 1080×2376（宽高比 0.45）毫无关系
```

实测：连续 6 帧都停在 330×165（2.0），而正确值应是 ~318×700。

所以尺寸必须由**帧的真实宽高比** + **父容器的可用空间**推出，再把结果
**同时**写回 CSS 尺寸与后备存储：

- CSS 尺寸（`style.width/height`）决定显示多大 —— contain 缩放，不变形、不溢出
- 后备存储（`canvas.width/height`）= CSS × DPR —— 1:1 映射物理像素，最清晰且不浪费

配套两点：`.mbm-media` 必须 `flex: none`（否则 flex 容器会拉伸它，宽高比又丢）；
坐标换算仍用 `frameSizeRef`（真实帧尺寸），不是 `canvas.width`。

修好之后 `contain` 退化为恒等映射（画面与容器同比例、已居中），坐标换算里的
偏移量恒为 0 —— 但那段代码保留着，因为容器比例仍可能与设备不同。

### 为什么客户端要构建（以及为什么产物进仓库）

**先摆硬约束**：DSH 把 client bundle 当**经典脚本**求值 —— 它只做
`window.__ModuleLoader__` 的注册，不做任何转译。运行时解析器只有四条分支
（DSH 源码原文）：

```
seed word → memoized record → graph row → registered factory;
anything else → throw (loud — the runtime mirror of the build-time bundle purity gate)
```

所以**不编译就既不能写 JSX，也不能拆文件** —— 相对 `require` 只对打包器产出的
chunk 有效，手写的兄弟文件解析不到。DSH 自己的客户端插件同样是打包出来的
（`packages/client/tsdown.client.ts`）。

早先的做法是接受这个约束、手写 `h(...)` 单文件。后来改了，因为：

- `h(...)` 嵌套到第四层就读不动了，54 处调用全是括号
- CSS 与布局挤在同一个文件里，改样式要在 1800 行里翻

**现在的做法**：源码是 `src/client/index.jsx`（JSX）+ `src/client/styles.css`
（样式），`npm run build` 经 esbuild 生成 `lib/client.js`。

三个刻意的决定：

1. **只转译、不打包**（用 esbuild 的 `transform`，不是 `build`）。
   产物必须保留 `window.__ModuleLoader__.load({ factory(require) {...} })`
   外壳，`require("react")` 也得留着 —— react 由宿主注入，打进产物就违反
   purity，还会和宿主的 React 变成两份实例。
2. **`jsxFactory: "h"`**：JSX 编译成 `h(...)`，与改造前同构。好处是产物仍是
   一堆 `h(...)` 调用，既有的源码断言测试继续有效（改成自动运行时 `_jsx(...)`
   会让十几处断言全部重写）。
3. **产物提交进仓库**。本插件以 **git 依赖**安装
   （profile 里写的是 `github:j62268781-alt/dsh-sidebar-mobile`），提交产物能让
   安装方**完全不需要工具链** —— esbuild 只是 devDependency。

产物进仓库的代价是**会漂移**（改了 src 忘了构建，安装方拿到的还是旧文件，
这种 bug 极难察觉）。所以 `npm run verify` 里有一道 `build:check`：重新构建
一遍并与提交的产物逐字节比对，不一致就直接失败。

另外两个构建细节，都是踩过的坑：

- **`charset: "utf8"` 必须显式设**。esbuild 默认 `ascii`，会把每个非 ASCII
  字符转义成 `\uXXXX` —— 对本项目（字符串与注释几乎全中文）会让产物变成
  一屏 `\u771F\u673A`，没法读也没法 review。实测确认过这个默认值。
- 构建时剥掉 esbuild 给每个 JSX 元素加的 `/* @__PURE__ */` 标注：那是给
  下游打包器摇树用的，本插件不打包产物，留着只会弄脏提交的文件。

CSS 走占位符 `__CLIENT_CSS__` **内联**成字符串常量，而不是让客户端去 fetch：
DSH 把插件注入的 `<style>` 标签纳入生命周期管理（打 `data-plugin`、卸载时
清理），内联正好走这条既有通道；异步 fetch 会引入首屏无样式闪烁，还多一条
失败路径。

### 为什么可以 require primitives（官方组件库）

`@deepseek-ai/dsh-client-ui-primitives` 是 web shell 的 **平台 seed 模块**：

```js
// dsh-web-frontend 的 staticModules
{ react, "react/jsx-runtime", "react-dom", "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit" }
```

seed 里的模块**永远可 require**，且**不需要**写进 `package.json` 的
`dsh.client.inject` —— 那个字段管的是「等哪些插件先加载」，不是「能不能 import」。
官方 terminal 插件就是直接 `require` primitives，而它的 inject 里没有它。

所以工具栏直接用官方的 `Button` / `Tooltip`，而不是自己写一套：

- `Button` 的 `sm` 是 **28px** 高、`variant="ghost"` 自带 hover 填充、
  `:disabled` 是 0.4 透明度、focus ring 也对。手搓的 26px 方块没有这些，
  看起来就"不像按钮"。
- 官方插件**从不用原生 `<select>`**：它的下拉箭头会吃掉右侧内边距，
  造成左 8px / 右 0 的歪斜。这里保留 `<select>`（键盘与无障碍是白送的），
  但 `appearance: none` 关掉原生箭头，自己画一个官方 chevron。
- 工具栏的 home / rotate / back / frame 图标官方没有（94 个 Regular 图标里搜过了），
  所以自绘，规格照抄官方：`viewBox 0 0 16 16`、`stroke currentColor`、
  `strokeWidth 1`。**不要用 "⌂" "▢" 这类字符**——字符的字重和基线跟旁边的
  SVG 图标对不齐。

### 图标：官方对同一图形有两套留白比例

这是"图标大小不一致"的真正原因，跟 `size` 参数无关：

| 场合 | 代表 | viewBox | 图形占比 |
|---|---|---|---|
| guide 入口胶囊 | `GuideArtworkBrowser` | 36 | **56.4%**（7.85→28.15） |
| tab 标签 | `IconGlobeOutlineRegular` | 16 | **76.1%**（1.91→14.09） |

同样 `size=16`，按 guide 比例画出来的手机只有 9.0px，
而旁边的文件夹/地球是 12.2px —— 肉眼一眼能看出一圈。

所以 `MobileArtwork` 收一个 `dense` 开关：guide 用 56.4%，标签用 76.1%
（描边也按 `2/36` vs `1/16` 各自归一）。两处都必须垂直居中。

另外 dockkit 的 `.tabTitle` 已经给了 `gap: 5px`，所以标签图标
**只**需要 `flex: none`；再加 `margin-right` 会变成 9px（官方「文件」是 5px）。

### 背压丢弃：两种格式的「帧边界」不是一回事

写缓冲积压超过 256 KB 时丢数据。阈值这么定：实测
`ServerResponse.writableHighWaterMark` 只有 **16 KB**，原本的 4 MB 是它的
256 倍 —— 等它生效画面早已落后几秒。256 KB（16 倍）既吸收突发又及时减负。

关键是**丢在哪里**。丢一个 chunk 不能拦腰截断当前帧，否则客户端会把它和下一帧
粘成坏单元 → 解码报错 → 丢弃所有非关键帧等下一个 IDR（实测可达 3–4 秒）→
表现为**花屏之后卡住几秒**。所以进入丢弃态后，一直丢到遇见**帧边界**再恢复投递。

⚠️ **但「帧边界」两种格式完全不同**：

| 格式 | 帧边界 | 用什么找 |
|---|---|---|
| H.264 | Annex B 起始码 `00 00 01` / `00 00 00 01` | `findStartCode` / `lastStartCode` |
| MJPEG | multipart boundary（`--<boundary>`） | `findBoundary` / `lastBoundary` |

早先两种格式共用起始码逻辑，这在 MJPEG 上是**错的**：JPEG 像素数据里天然大量
出现 `00 00 01`（实测 36 MB 流里 1925 个三字节 + 3465 个四字节）。按它截断会切出
不含 boundary 的半截 JPEG —— 浏览器只在读到**下一个 boundary** 时才认为上一帧结束，
所以那一帧永远等不到结束标记（不渲染），恢复投递后的残余字节还会被当成上一帧的
像素（该帧损坏）。

实测对照（真实 iOS 模拟器流，抽样 719 个 64 KB 块）：按起始码切 **506 次切在帧中间**；
按 boundary 切 **0 次**。

MJPEG 实测 21.8 Mbps、每帧 ~35 KB，而阈值 256 KB —— 积压约 7 帧就触发，
所以这是日常路径，不是边角情况。

### 为什么工具描述写得那么长

工具的 `description` 是模型唯一的线索。三种观察方式的代价差一个数量级：

```
mobile_ui_tree    ~100–300ms   结构化，首选
mobile_screenshot ~200–400ms   给人看
mobile_find_text  ~1s          OCR，兜底
```

不写明"先用哪个"，模型会在纯文本模型上反复调 `mobile_screenshot` 然后一无所获（截图是 image block，纯文本模型读不了）。

同理，`mobile_tap_element` 找不到元素时会把当前可见元素摘进错误信息——省掉模型"再读一次树"的往返，也避免它反复猜同一个错名字。

### 工具 vs skill：谁该承担什么

这不是审美问题，是**每轮成本**问题。两个数字（都用宿主自己的
`dsh-token-meter` 公式 `ceil(chars/4)+4` 实测）：

| | tokens | 何时付费 |
|---|---|---|
| 工具 schema | 11 个 = **964** | **每轮**（工具面随每次请求发出） |
| skill 摘要 | **213** | **每轮** |
| skill 正文 | **5137** | 载入后**每轮**（正文是 tool result，留在历史里） |

两条由此推出的结论：

**① 薄包装不该做成工具。** 一个只是 `runJson(...)` 加一句 `return` 的工具，
和 agent 直接跑 `mobilecli` 等价（`dsh-tool-bash` 在 dsh-base 里，恒可用），
却要为它的 schema 每轮付费。删掉 5 个省 **453 tokens/轮**。

要留下的是"CLI 做不到"的那些：
- `mobile_ui_tree` —— 把 mobilecli 的**嵌套**树拍平（实测只读顶层 0 个可用元素，
  拍平后 92 个）。skill 只能让模型跑 `dump ui`，拿到的是没拍平的。
- `mobile_boot` —— 启动后 `acquireSession` 订阅一次把面板的流拉起，**插件内部状态**。
- `mobile_wait_for` —— OCR 轮询循环，单次 CLI 调用表达不了。
- `mobile_devices` —— 合并设备数据与流池的 `streaming` 状态。
- 其余：`tap_element` / `tap_text` / `find_text`（定位 + 失败时附可见元素）、
  `screenshot`（落临时文件）、`logs`（限流+过滤）、`list_apps`（字段归一化）。
- `mobile_open_panel` —— **跨进程**：Host 上的工具要去驱动浏览器里的侧边栏。
  这是插件里唯一一个"动作发生在另一个进程"的能力，靠客户端长轮询 + 回执实现
  （见 `lib/stream/routes.js` 里 `#panelOpen` 的注释）。

  ⚠️ 它**必须**挂在客户端 `apply(ctx)` 里而不是面板组件里 —— 挂在组件里就只有在
  面板已经打开时才会轮询，而这个功能的全部意义恰恰是打开一个**还没打开**的面板。
  测试「请打开面板的轮询必须在 apply() 里」钉住这条。

⚠️ `flutter_tree` 曾被列在这里，但那是错的：它不是「加工型」，而是
`ui_tree` 的副本（两者调同一个 `dumpUiElements`），描述却声称直连 VM Service。
已删除 —— 理由与替代路径见 [FLUTTER-TREE-RESEARCH.md](FLUTTER-TREE-RESEARCH.md)。

**② skill 的触发描述是成本杠杆，不是文案。** `description` + `whenToUse`
进每轮索引；一旦诱导模型在本可直接调工具的场景去载入技能，代价是
**5137 tokens**，而且是**每一次误触发**。实测这笔误触发是工具瘦身收益的 ~15 倍，
所以**先收紧触发描述、再删工具**。

本插件的触发描述因此明确写了两件事：只在工具做不到时用；并列出"别为我载入"
的场景。测试直接断言这一点（`skill 的触发描述不许覆盖工具已能做的场景`），
因为它坏了不会有任何报错，只会悄悄变贵。

### 为什么失败一律 throw，不做空值兜底

"没有设备"和"设备列表拿不到"必须可区分。把故障伪装成空列表会让模型得出"这台机器没有设备"的错误结论，然后沿着错路继续走很远。

所以：枚举失败一律抛；`count: 0` 只在调用成功时才可能是事实。

### 流中断：两条链路必须各修各的

用户报告"滚动的时候解码器发生错误了，然后画面直接死了"。查下来**不是解码器
的问题**，而是两个各自独立的缺陷叠加：

**① Host 崩溃后浏览器收不到任何通知。**
流进程崩溃时 `StreamSession` 会自己重启（`#scheduleRestart`），但**浏览器这条
HTTP 响应不会被关闭** —— 没人调用 `res.end()`。于是客户端的
`reader.read()` 永远挂着：既不 `done` 也不 `error`，看起来和"画面静止"一样。

**② 客户端没有重连。**
一次 `run()` 结束就 `report("ended")` 返回，而 `useEffect` 的依赖
（`streamUrl`）没变 —— 所以**再也不会重新取流**。画面永久停在终态。

修法是两条链路各修各的：

- 客户端加**停流看门狗**：3 秒没收到任何字节就主动 `reader.cancel()`，
  把"静默挂起"变成一次可见的失败。
- 客户端加**自动重连**（退避 1s→8s，收到数据即复位）。

⚠️ 看门狗只能看"有没有数据"，**不能看帧率**：静止画面时编码器可能只发很稀疏
的帧，按帧率判断会把正常画面误杀。

#### 顺带修掉：退避会单向累积

`crashCount` 原先只在**空闲自停**时清零，所以它只增不减：

```
crashCount  1  2  3  4  5  6 → 上限
退避        5s 10s 15s 20s 25s 30s
```

后果是"越用越糟"：几次抖动之后，即使流跑得很好，下次崩溃也要干等 30s。
现在拿到**第一块数据**就清零。

用"首块到达"而不是"进程还活着"作为成功信号很重要 —— 进程起来立刻退出
（设备端 agent 没起来时只输出 `Error:`）不该算成功，否则会退化成无退避的
快速重启循环，把设备端 agent 打爆。

#### 一个容易误判的坑

隔离验证时用真实 `StreamSession` + 真实 `StreamRoutes`：消费保持订阅时杀进程
→ Host 重启 → **同一条 HTTP 响应继续收到数据**（8 → 15 字节）。

也就是说 Host 侧的重启链路本来是通的；线上那次"20 秒没恢复"是退避累积
（旧代码）造成的，不是重启逻辑坏了。**修之前要先用隔离实验区分这两者**，
否则很容易去"修"一段本来就正确的代码。

### 交互热路径不许查设备列表

用户反馈"点一下按钮要等 300 多毫秒"。实测分解（一加 12 真机）：

| 步骤 | 中位数 |
|---|---|
| `mobilecli devices --include-offline` | **328 ms** |
| `mobilecli io tap` | **103 ms** |
| 合计（原实现） | **431 ms** |

也就是 **76% 的点击延迟花在一个只用来"确认设备还在"的预检查上**。
对运行中的服务实测更夸张：缓存（1.5s TTL）过期时单次 tap **576 ms / 516 ms**。

`#requireActiveDevice()` 因此改成同步返回记住的 id，**不做存在性复核**：

- 设备真掉线时，`mobilecli` 自己会报
  `{"status":"error","error":"error finding device: device not found: <id>"}`
  —— 措辞一样清楚，只是晚 328ms；
- "离线"本来就有更权威的信号：5 秒状态轮询会更新设备列表，面板据此禁用按钮。

那个预检查只买到"早 328ms 失败"，代价是让**几乎每次正常操作**都慢 328ms。
用真实 `StreamRoutes` 驱动验证：**431 → 105 ms**，调用序列只剩一次 `io tap`。
（`activeDeviceId === null` → 409 的判断要保留，别连它一起删掉。）

#### 剩下的延迟里，哪些动不了

| 步骤 | ms | 说明 |
|---|---|---|
| 浏览器 POST → Host | 5 | 同机 loopback |
| Host 解析 + 校验 | 1 | 纯 JS |
| **mobilecli 进程启动** | **62** | POSIX Node CLI 样本；Windows 原生 binary 的启动开销不同 |
| daemon IPC + adb 往返 | 41 | 实测 |
| 下一条编码帧 | 17 | ~60fps 编码周期 |
| adb/USB 回传 | 20 | 1080p 帧 ~35KB |
| Host 转发 + 背压 | 2 | 16KB hwm |
| 浏览器解码 | 5 | WebCodecs 硬件解码 |
| 渲染限流等待 | 17 | 30fps 的半个周期（均值）|
| drawImage + 合成 | 8 | 主线程 |
| **合计** | **~178** | |

那 62ms 的进程启动**目前无法消除**：`mobilecli` 是 Node CLI，输入类命令
（`io tap/swipe/longpress/pinch/button/text/keys/clipboard`）全是**一次性**命令，
没有常驻输入通道 —— 唯一的常驻进程是 daemon，但它不对外暴露输入 socket。
所以 ≈100ms 是每个动作的下限。

渲染限流也不是延迟杠杆：源流 ~120fps，限到 60fps 只是隔帧绘制，
**等待下一个绘制点的时间没变**；真正拖累跟手的是主线程被 `drawImage` 占满。
（同理：只能丢绘制，绝不能丢解码 —— P 帧依赖参考帧。）

### 为什么 UI 树要递归展平

mobilecli 的 `dump ui --format json` 返回**嵌套树**（子节点挂在 `children` 下）。直接读 `data.elements` 只拿到最外层几个容器——实测同一屏：展平前 0 个元素、展平后 92 个。

这是"读出一片空白"的典型来源。抽出 `dumpUiElements()` 供所有读取工具共用。

## 生命周期

所有注册都经 `ctx.effect`，卸载时自动注销。**disposer 逆序执行**：先注销工具/技能，再摘路由，最后停流子进程。

反过来会有一个窗口：路由还在但处理器已经释放，期间进来的请求会打到已卸载的对象上。

`ctx.inject` 的返回值形状随 DSH 版本变化（可能是 fiber，也可能没有 `dispose`），所以清理时先判 `typeof`，且把它只当兜底——真正的清理由内部的 `effect` disposer 负责。

## 零运行时依赖

`package.json` 没有 `dependencies`。`react` 用宿主提供的（`require("react")`），`@deepseek-ai/*` 同理。

`lib/agent/tool-support.js` 把"依赖宿主"收敛到一处：`defineTool` 与 `ToolArgsError` 由 `@deepseek-ai/dsh-tools` 提供。不自己实现它们，因为 `defineTool` 负责 schema 编译与校验，自己实现会与宿主规则产生偏差，而偏差的表现是"工具在某些参数下静默失败"。

⚠️ 这个 import 在没有宿主的环境会失败，所以 `test-harness.mjs` 只加载纯逻辑模块，不加载 `tools.js` / `index.js`。
