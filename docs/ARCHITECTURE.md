# 架构与关键取舍

面向要改这个插件的人。用户只需要看 [README](../README.md)。

## 分层

```
浏览器（右侧边栏 tab）
  │  只经 DSH 自己的 web 源，从不接触 mobilecli 的端口
  ▼
lib/client.js            tab 类型 + 正文组件；两条渲染路径（H.264 / MJPEG）
  │  fetch POST /_dsh/dsh-sidebar-mobile/{grant,control,device-action,status}
  │  <img|canvas> GET …/stream/<token>
  ▼
lib/stream-routes.js     路由分发、body 解析、错误收敛
  ├── lib/stream-access.js    签名令牌 + loopback 围栏
  └── lib/stream-session.js   单流多播、空闲自停、崩溃重启
        │
        ▼
lib/mobilecli.js         二进制解析、execFile 调用、spawn 流进程
        │
        ▼
mobilecli（Go 二进制）
  │  adb / simctl / usbmux / on-device agent
  ▼
设备
```

Host 侧另有两个平级的模块：

- `lib/tools.js` —— 16 个模型工具，全部经 `defineTool` 注册
- `lib/skills.js` —— 把打包的 mobilecli playbook 注册给模型

`index.js` 负责接线，并用 `ctx.effect` 保证卸载时全部注销。

## 关键取舍

### 为什么用 CLI 而不是 mobilecli 的 server 模式

mobilecli 有 `server start` + JSON-RPC，返回 `sessionUrl` 供二次连接。本插件没用它，理由：

- server 模式要多管一个常驻 HTTP 服务（端口占用、会话过期、二次清理）
- `screencapture` 写 stdout 的路径已被实测验证（Android 104fps / iOS 131fps）
- 少一层进程就少一类失败

代价是流格式无法从 API 声明得知，只能从首块字节嗅探——但这本来就是必需的（见下）。

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

### 为什么客户端不用 JSX / 不用构建

DSH 把 client bundle 当**经典脚本**求值（官方产物 0 个顶层 import）。别的插件靠 esbuild 预转译，那会引入构建步骤与 devDependencies。

本插件承诺零运行时依赖，也不想让使用者为了改一行样式就装工具链，所以直接用 `React.createElement`（别名 `h`）。单文件、无需构建、改完刷新即生效。

代价是写起来啰嗦。对一个面板来说可以接受。

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

### 为什么工具描述写得那么长

工具的 `description` 是模型唯一的线索。三种观察方式的代价差一个数量级：

```
mobile_ui_tree    ~100–300ms   结构化，首选
mobile_screenshot ~200–400ms   给人看
mobile_find_text  ~1s          OCR，兜底
```

不写明"先用哪个"，模型会在纯文本模型上反复调 `mobile_screenshot` 然后一无所获（截图是 image block，纯文本模型读不了）。

同理，`mobile_tap_element` 找不到元素时会把当前可见元素摘进错误信息——省掉模型"再读一次树"的往返，也避免它反复猜同一个错名字。

### 为什么失败一律 throw，不做空值兜底

"没有设备"和"设备列表拿不到"必须可区分。把故障伪装成空列表会让模型得出"这台机器没有设备"的错误结论，然后沿着错路继续走很远。

所以：枚举失败一律抛；`count: 0` 只在调用成功时才可能是事实。

### 为什么 UI 树要递归展平

mobilecli 的 `dump ui --format json` 返回**嵌套树**（子节点挂在 `children` 下）。直接读 `data.elements` 只拿到最外层几个容器——实测同一屏：展平前 0 个元素、展平后 92 个。

这是"读出一片空白"的典型来源。抽出 `dumpUiElements()` 供所有读取工具共用。

## 生命周期

所有注册都经 `ctx.effect`，卸载时自动注销。**disposer 逆序执行**：先注销工具/技能，再摘路由，最后停流子进程。

反过来会有一个窗口：路由还在但处理器已经释放，期间进来的请求会打到已卸载的对象上。

`ctx.inject` 的返回值形状随 DSH 版本变化（可能是 fiber，也可能没有 `dispose`），所以清理时先判 `typeof`，且把它只当兜底——真正的清理由内部的 `effect` disposer 负责。

## 零运行时依赖

`package.json` 没有 `dependencies`。`react` 用宿主提供的（`require("react")`），`@deepseek-ai/*` 同理。

`lib/tool-support.js` 把"依赖宿主"收敛到一处：`defineTool` 与 `ToolArgsError` 由 `@deepseek-ai/dsh-tools` 提供。不自己实现它们，因为 `defineTool` 负责 schema 编译与校验，自己实现会与宿主规则产生偏差，而偏差的表现是"工具在某些参数下静默失败"。

⚠️ 这个 import 在没有宿主的环境会失败，所以 `test-harness.mjs` 只加载纯逻辑模块，不加载 `tools.js` / `index.js`。
