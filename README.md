<div align="center">

# dsh-sidebar-mobile

**把手机装进 DSH 的右侧边栏 —— 实时画面 + 直接点击，一套 API 同时覆盖 iOS 与 Android**

[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2%20实测-4c6ef5)](#)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/npm%20test-43%20passed-2ea043)](#自测)
[![runtime deps](https://img.shields.io/badge/运行时依赖-0-8a8f99)](#它怎么做)

</div>

---

`mobilecli` 是一条覆盖 iOS 与 Android 的设备控制 CLI，但它的 `screencapture` 只能写到 stdout、没有面板。本插件把它封进 DSH 的右侧边栏，并把能力同时开放给人和模型。

- 📺 **实时画面**：Android 走 AVC/H.264（实测 **104fps**），iOS 模拟器走 MJPEG（实测 **131fps**）
- 👆 **直接在画面上操作**：点击即点击、拖拽即滑动，等比例换算回设备坐标
- 🧰 **11 个模型工具**：读 UI 树、按标识点元素、读日志、等文本出现、**把面板打开给你看**
- 📱 **一套 API 两端通用**：真机、模拟器、模拟机走同一条路径，没有平台分支
- 🎓 **自带 mobilecli 的 skill**：把上游 playbook 打包注册给模型，不用自己往 `.agents/` 抄
- 🔐 **浏览器从不接触设备端口**：只经 DSH 自己的 web 源，签名令牌 + loopback 围栏
- 📦 **零运行时依赖**：`react` 用宿主那份；客户端源码是 JSX，但**产物已提交**，安装方无需工具链（见[开发与自测](#开发与自测)）

**目录**：[它解决什么问题](#它解决什么问题) · [安装](#安装) · [配置](#配置) · [使用](#使用) · [安全模型](#安全模型) · [已知边界](#已知边界) · [更多文档](#更多文档) · [License](#license)

## 它解决什么问题

DSH 社区已有一个 Android 插件和一个 iOS 插件，但各自踩了一个性能坑：

| 方案 | 取帧方式 | 实测帧率 |
|---|---|---|
| `dsh-android` | `adb exec-out screencap` 循环（PNG） | **~1.8fps** |
| `dsh-ios` | serve-sim MJPEG | 与下同量级 |
| **本插件（Android）** | mobilecli AVC / H.264（MediaCodec 硬编） | **104fps** |
| **本插件（iOS 模拟器）** | mobilecli MJPEG | **131fps** |

瓶颈不在 adb，而在**每帧搬一张完整 PNG**：1080p PNG 每帧几百 KB，H.264 每帧几 KB，差两个数量级。mobilecli 在设备端用 MediaCodec 编码，只把压缩后的码流传回来。

### ⚠️ Flutter 应用读元素会读不到，这是预期的

Flutter 把整个 UI 画进一块不透明的原生 view，**无障碍树只能看到应用主动投影出去的那部分**。实测一个真实的 Flutter 应用（debug 构建）：

```
mobilecli dump ui --format json  →  69 个节点，全部是 android.*
  其中 32 个是 systemui 状态栏（时间/网速/wifi/电池），与你的应用无关
  应用窗口下全是匿名 View / ImageView —— 只有 rect，没有 text、没有 identifier
```

更深一层：Flutter 的**语义树默认根本不生成**（框架出于性能考虑，只在检测到读屏类辅助技术时才生成）。所以这不是 mobilecli 的缺陷，是 Flutter 的渲染模型决定的 —— 关掉读屏时 `ext.flutter.debugDumpSemanticsTreeInTraversalOrder` 会明确回你：

> Semantics not generated … the framework only generates semantics when asked to do so by the platform.

要读**真正的 widget 树**必须走 Dart VM Service，或在 Flutter 工程里跑 `integration_test` / Patrol。两条路线的完整实测（协议细节、踩坑、阻塞项）见 **[docs/FLUTTER-TREE-RESEARCH.md](docs/FLUTTER-TREE-RESEARCH.md)**。

本插件**不提供**这个能力 —— 早先的 `mobile_flutter_tree` 只是个空承诺（它与 `mobile_ui_tree` 调同一个函数，却声称直连 VM Service），已删除。

## 安装

### 前置：mobilecli

```bash
npm install -g mobilecli@latest
mobilecli devices          # 确认能看到设备
```

### 前置：adb（Android 必需）

**Android 设备必须装 adb** —— mobilecli 不自己实现 adb 协议，它调用外部 `adb`。
而 **adb 缺失时 mobilecli 不报错**：

```json
{"status":"ok","data":{"devices":[]}}     // exit code 0，完全看不出问题
```

真相只在 daemon 日志里：`Failed running 'adb devices', is ANDROID_HOME set correctly?`。
所以手机明明插着、驱动也正常，设备列表却是空的 —— 大概率就是缺 adb。

```bash
# 1) 下载 platform-tools
#    https://developer.android.com/tools/releases/platform-tools
# 2) 让 adb 可被找到：加进 PATH，或设 ANDROID_HOME 指向 platform-tools 的**上一级**
# 3) 重启 DSH，然后让 daemon 重新读取环境
mobilecli daemon stop
```

> ⚠️ **两个都会踩的坑**
>
> **① 环境变量是"启动时快照"。** 装完 adb 后**必须重启 DSH** —— 已运行的进程
> 看不到新写的 PATH / ANDROID_HOME。插件会区分这两种情况：确认 adb 装了但当前
> 进程看不到时，提示的是"重启 DSH"而不是"去装 adb"。
>
> **② daemon 也会缓存环境。** mobilecli 的 daemon 是常驻进程，继承**启动那一刻**
> 的环境。所以即使 DSH 的环境对了，旧的 daemon 仍会报"没有设备" —— 必须
> `mobilecli daemon stop`（或等它空闲 30 分钟自动退出）。

面板在"一台设备都没有"时会显示一条可照做的诊断（含 adb 路径与下一条动作），
而不是只显示"未发现设备"。

iOS 真机还需要在设备上装 agent（**本插件不会自动装**）：

```bash
mobilecli agent status --device <udid>
mobilecli agent install --device <udid>          # 真机需要 provisioning profile
```

iOS 模拟器同样需要装一次 agent，否则取流会报 `agent is not installed`。

### 装插件

```bash
dsh plugin --profile web add @j62268781-alt/dsh-sidebar-mobile@latest
dsh web
```

或作为已有 profile 包的依赖：

```bash
pnpm add @j62268781-alt/dsh-sidebar-mobile
```

装完刷新页面，右侧边栏的「开始」页出现「移动设备」入口，点它打开面板。

也可以直接按快捷键（胶囊右侧会显示对应徽标）：

| 环境 | 键位 |
|---|---|
| 桌面应用 | `⌘⇧M`（Windows/Linux 为 `Ctrl+Shift+M`）|
| 浏览器 | `⌘⌥M`（Windows 为 `Ctrl+Alt+M`）|

> 桌面端**没有**用 `⌘M`：macOS 把 `⌘M` 绑给了系统「最小化」，原生菜单会先吃掉这个键。
> 键位可在 **设置 → 快捷键** 里改；与 DSH 自带的 8 条绑定均无冲突（已按宿主自身的
> 绑定规则校验过保留键与重叠）。

> **它是「开始」页的第 5 个胶囊（官方 3 个 + `dsh-context` 1 个）**。DSH 的「开始」页有条硬规则：
> 胶囊超过 4 个，就关掉**所有**胶囊的副标题（`MAX_DESCRIBED_ENTRIES = 4`，不是只关第 5 个）。
> 所以装上本插件后，「工作区文件 / 上下文 / 新建终端 / 浏览器」的副标题会一起消失——
> 这是上游的取舍，插件侧无法只为自己豁免。要恢复副标题，只能把入口挪到会话标题栏
> （`conversation.session.header.utilities`），而不是改本插件的 `description`。

> **桌面版**：`desktop` profile 由桌面应用独占，宿主 CLI 的 `dsh plugin --profile desktop` 会被拒绝。桌面端请走 **设置 → 插件市场**。

## 配置

全部配置在 profile 的 `cordis.patch.yml` 里，挂在 `dsh-sidebar-mobile` 这一行下：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后插件仍加载，但不挂路由、不注册工具与技能 |
| `binaryPath` | `null` | mobilecli 路径。`null` 走四级自动解析（见下） |
| `homeDir` | `null` | `MOBILECLI_HOME`。`null` 用 mobilecli 默认的 `~/.mobilecli` |
| `routePrefix` | `/_dsh/dsh-sidebar-mobile` | 路由前缀 |
| `registerSkills` | `true` | 是否把 mobilecli 的 skill 注册给模型 |
| `mobileLoop.enabled` | `false` | 显式开启后注册 judgment-backed `mobile_loop` |
| `mobileLoop.purpose` | `mobile.action` | dsh_judgment 中已配置且可用的 purpose |
| `stream.idleStopSeconds` | `300` | 无消费者后多久停流 |
| `stream.restartDelayMs` | `5000` | 流崩溃后的重启延迟 |
| `stream.bitrate` | `0` | AVC 码率（bps）。`0` = 按 scale 自动推导（满分辨率 10 Mbps）；显式填数字则固定该值 |
| `stream.maxFps` | `30` | 请求上游帧率（当前测试设备上参数无效）；浏览器在 rAF 里按 60 FPS 绘制 |
| `stream.defaultScale` | `0` | `0` = 按面板画布物理像素自动决定，并跟着面板变化重取（侧边栏通常 ≈0.55）；`0.35`–`1` = 固定缩放 |
| `useDaemonRpc` | `true` | 优先走 daemon JSON-RPC；可用时历史 tap 实测 7.3ms vs CLI 104.2ms。Windows socket 权限错误会停用 RPC 并回退；排查时设 `false` |
| `trustedAuthorities` | `[]` | 经反向代理访问时显式列出对外 authority |

`binaryPath` 为 `null` 时的**四级解析**顺序：

1. `MOBILECLI_PATH` 环境变量
2. `PATH` 上的 `mobilecli`（`npm -g` 装的 shim）
3. 本包 `node_modules` 里的平台包（`@mobilenext/mobilecli-<os>-<arch>`）
4. 全落空 → 工具仍注册，调用时给出安装提示（而不是插件加载失败）

## 使用

### 面板

右侧边栏 →「移动设备」：

- **设备下拉**：按类型**分组**（真机 / 模拟器），每项形如 `一加 12 · 真机`；离线再加「（离线）」。类型来自 mobilecli 的 `type` 字段（`real` / `simulator` / `emulator`），认不出的值原样显示而不猜 —— 实测同时插着真机和模拟器时，只显示名字**完全分不出哪个是模拟器**
- **点一个离线模拟器会先把它启动起来**（冷启动可达数分钟，期间显示启动提示，别以为卡死了）。离线**真机**只选中、不启动 —— 真机不归 adb 启动。启动失败不影响选中，但会如实报错，不会让你对着黑屏猜
- **⌂ / ◁ / ⟳**：主屏幕 / 返回（仅 Android）/ 旋转
- **⟲**：重新申请令牌并重连（画面卡住时用）
- **▢ / ▣ / ▤**：切换外观（边框 / 真机 / 无框）
- **在画面上点击** → 点设备的对应位置；**拖拽** → 滑动
- **模型也能替你打开这个面板**（`mobile_open_panel`）。⚠️ 它**不是给模型读界面用的** —— 面板在浏览器里、不在模型上下文里。用途是需要你**亲眼看**屏幕时把它推到你面前

状态栏显示 `实时/未串流`、平台、以及实际拿到的流格式（`H.264` 或 `MJPEG`）。

### 模型工具

默认注册 **11 个**「工具能做得比 CLI 更好」的工具；`mobile_loop` 默认关闭，仅在显式启用 judgment 后额外注册：

| 工具 | 用途 |
|---|---|
| `mobile_devices` | 列出所有设备（**先跑这个**拿到 device id） |
| `mobile_boot` | 启动设备并开始串流（画面出现在面板） |
| `mobile_ui_tree` | **读界面首选**：类型、文本、identifier、坐标 |
| `mobile_screenshot` | 截图（给人或多模态模型看，不是读界面的首选） |
| `mobile_tap_element` | **按标识/文本点元素**（比坐标稳，可带 `expect_text` 一并验证） |
| `mobile_list_apps` | 列已安装应用（启动前先列，别猜包名） |
| `mobile_find_text` / `mobile_tap_text` | OCR 找文字 / 点文字（树读不到时的兜底） |
| `mobile_wait_for` | 等文本出现或消失 |
| `mobile_logs` | 读设备日志（logcat / unified log） |
| `mobile_open_panel` | **把侧边栏的移动设备面板打开给用户看**（跨进程，需要客户端在跑） |
| `mobile_loop` | **可选**：由 dsh_judgment 选择下一步低风险控件，最多自动点 5 步；默认不注册 |

带 `device` 参数时请传 `mobile_devices` 返回的 **id**。显式 id 直接交给 mobilecli，不再先运行一次 `devices` 枚举；这省掉了历史样本中约 381ms 的设备查询，但不代表当前机器的固定 SLA。省略 id 时仍会枚举，并要求恰好一台在线设备。名称不再作为 `device` 参数解析。

`mobile_tap_element` 和面板点击会优先尝试 daemon JSON-RPC；POSIX 的历史实测约 7.3ms vs CLI 104.2ms。Windows 的 Node socket 连接可能被系统拒绝，插件会停用该会话的 RPC 并回退 CLI。请先用 `useDaemonRpc: false` 做对照，再按设备记录端到端延迟。

#### Judgment-backed mobile loop

默认关闭；在 `cordis.patch.yml` 中设置 `mobileLoop.enabled: true` 后才注册 `mobile_loop`，purpose 默认是 `mobile.action`，可通过 `mobileLoop.purpose` 改名。DSH 必须提供 dsh_judgment API v1 且对应 purpose 可用；未配置时工具会报告不可用，不会换成别的模型或默认答案。

每次判断会把用户目标和最多 12 个控件标签发给配置的 judgment 服务；只做邮箱/长数字遮蔽与长度截断，不发送截图或完整 UI 树，因此并非通用隐私脱敏。loop 上限 5 步，只点击控件；会排除输入框和明显涉及提交、发送、支付、删除、授权、权限、上传、分享、保存、安装等标签，点击前重新读取 UI 并核对 judgment fingerprint。弃答、低置信度、无效响应或 UI 变化都会停止，不会自动重试。不要在含敏感信息的屏幕启用它。它是受限的结构化 UI loop，不是完整视觉 agent。

性能方面，默认按**面板像素**取流（`defaultScale: 0` → 侧边栏通常得 `scale≈0.55`，即 598×1318 而不是 1080×2376），而且这个 scale 是**跟着画布走的**：拖宽面板、或把窗口拖到另一块屏（DPR 1↔2）之后，客户端会按画布的后备存储像素重新上报 `preferredWidth`，Host 在新 scale 比当前大 >15% 时重建编码器（一次性闪屏 ≈0.54s，同设备 3 秒节流），于是**任何时候都是 1:1 显示**，不再有"小分辨率铺大画布"的放大糊。码率按 scale 自动推导（`bitrate: 0`，满分辨率给 10 Mbps）。实测同一台一加 12 连续横滑：1080×2376 时解码负载 260 Mpx/s、每像素比特 0.027；628×1384 时降到 89 Mpx/s、每像素比特 0.048 —— 解码量只有 34%，每像素比特反而多 1.8 倍。mobilecli 的 `--fps` 在已测设备上无效，浏览器侧逐帧解码保留 H.264 参考链、只在 rAF 里按 60 FPS 绘制。多出来的像素在画布上本来显示不出来，最后被浏览器降采样丢掉，纯属白解码；要固定满分辨率排查时把 `defaultScale` 设成 `1.0`。画布宽度另封顶 300 CSS px（= 宿主右侧边栏最小宽度），面板再宽手机也不会被放成"巨屏"。

#### 为什么不给 tap / swipe / 输入 / 按键 / 启动应用注册工具

这 5 个曾是工具，但只是 `mobilecli` 的薄包装（一次 `runJson` 加一句 `return`），
没有任何加工 —— 而 agent 本来就有 shell，直接跑等价命令即可：

```bash
mobilecli io tap --device <id> 540,1200
mobilecli io swipe --device <id> --duration 250 540,1800,540,700
mobilecli io text --device <id> "hello"
mobilecli io button --device <id> BACK
mobilecli apps launch --device <id> com.example.app
```

这 5 个的 schema 每次请求都要发 —— **删掉它们实测省 453 tokens/轮**
（16 个 = 1487 → 11 个 = 1034）。

> 此后又删了 `mobile_flutter_tree`（与 `mobile_ui_tree` 重复），
> 并加了 `mobile_open_panel`。**当前是 11 个 = 964 tokens/轮** ——
> 数的个数一样，但不是同一批工具，别把这个差值和上面的 453 混起来。

⚠️ 关键细节没跟着删，都在 skill 的「Driving the device from the shell」一节：
坐标是**物理像素**、`io swipe` **必须传 `--duration`**（否则默认 1000ms 慢动作）、
输入前必须**先聚焦**、`io button` 的键名、启动前先列应用。
被删的名字留在 `REMOVED_TOOL_NAMES` 里，便于分辨「插件删了它」和「名字打错了」。

工具描述里写明了"先用哪个、什么时候升级到下一个"，因为三种观察方式的代价差一个数量级：

```
mobile_ui_tree    ~100–300ms   结构化，首选；该历史范围不含可省略的设备枚举时间
mobile_screenshot ~200–400ms   给人看
mobile_find_text  ~1s          OCR，兜底
```

### 自带 skill

mobilecli 仓库里的 playbook（`SKILL.md` + `reference.md`）被原样打包并注册，模型可以直接读到命令的完整用法、平台差异、以及一批踩坑记录。**不需要你往 `.agents/` 里抄一份。**

## 安全模型

**浏览器从不接触 mobilecli 的端口**（它监听 localhost 且没有鉴权）。所有字节只经 DSH 自己的 web 源：

```
<img src="/_dsh/dsh-sidebar-mobile/stream/<token>">
     → 围栏校验 → Host 转发到 mobilecli → 回传
```

两道闸门，**顺序不可颠倒**：

1. **传输层围栏（先）**：对端必须是 loopback（TCP 层事实，客户端伪造不了）；`Host` 头必须是 loopback 或显式配置的 `trustedAuthorities`。`Host` 与 `Origin` 是客户端可控数据，这里只用它们**否决**，从不用来授权。
2. **capability（后）**：HMAC-SHA256 签名，10 分钟过期。`deviceId` 参与签名，所以给 A 设备签的令牌拿到 B 上用不了。

为什么不只用 token：它会进浏览器历史、日志、`Referer`。围栏先挡住"根本不是本机来的"请求，token 才有意义。

自测覆盖了 DNS rebinding、令牌篡改、过期、跨 `DSH_HOME` 复用、跨站 POST。

## 已知边界

- **⚠️ mobilecli 会独占设备的 UiAutomation**。上游源码注释原文：*"While it runs it holds the device's only UiAutomation, which kills every other UiAutomator client (`uiautomator dump`, Appium)."* **实测确认**：daemon 运行时 `adb shell uiautomator dump` 静默失败（文件根本不生成），`mobilecli daemon stop` 后立刻恢复。受影响的是 Appium、UiAutomator、以及任何依赖 `uiautomator dump` 的工具；不受影响的是 `adb shell input`、`screencap`、以及**进程内的 Flutter 测试**（`integration_test` / `patrol` 的 Dart 部分不碰 UiAutomation）。
- **⚠️ Android 必须有 adb，且 mobilecli 不会为此报错**。缺 adb 时 `devices` 返回空列表 + exit code 0，看起来跟"没插手机"一模一样。插件会主动体检并区分这两种情况（见[前置：adb](#前置adbandroid-必需)）。
- **⚠️ `--fps` 参数不生效**。复测（Xiaomi 15 Pro / 1080×2400 / mobilecli 1.0.19）：不传 → 120.6fps，`--fps 30` → 105.5fps，`--fps 15` → 100.7fps，传什么都是 ~120fps。所以限流只能在**客户端渲染侧**做：插件每帧都解码（保住 H.264 参考链 —— 丢 P 帧会花屏），但只在 rAF 里按 60fps 绘制最新帧。想降带宽只能用 `--scale` 或 `--bitrate`。
- **⚠️ swipe 不传 `--duration` 时会跑满 1000ms**。实测 `io swipe` 不带该参数耗时 1074ms，带 `--duration 300` 只需 374ms。插件按手指按住时长自动计算并透传。
- **⚠️ `--bitrate` 默认值偏低，但它是软上限**。实测 1080×2400 静止仅 0.98 Mbps、滑动 2.15 Mbps（大范围运动时明显发糊）。插件默认给满分辨率 10 Mbps（按 scale² 折算、下限 5 Mbps）。注意设 4 Mbps 实测仍出 6.79 Mbps，所以它不能当限流用。
- **⚠️ iOS 的 `--format avc` 会被静默降级成 MJPEG**。这也是本插件从首块字节嗅探格式、而不相信请求参数的原因。
- **多个 DSH 进程不能共用同一个 daemon**。需要并行时给每个 profile 配不同的 `homeDir`。
- **⚠️ 从源码装时不能用软链**。本插件的 Host 半 import 宿主包（`@deepseek-ai/dsh-tools`），而 Node 的 ESM 解析会以软链的**真实路径**为基准去找 `node_modules`——源码目录下没有那些包，于是启动日志报 `failed to import`（伴随 `1 entry did not activate`）。**实测对照**：同一个插件软链失败、真实目录成功。用 `dsh plugin add "link:$PWD"` 或 `cp -R` 成真实目录，见 [docs/DEPLOY-DSH.md](docs/DEPLOY-DSH.md)。发到 npm 后不受影响。

## 开发与自测

客户端半边有**源码与产物之分**，改客户端代码前先看这一节：

```
src/client/index.jsx    ← 手写源码（JSX）
src/client/styles.css   ← 手写源码（样式）
lib/client.js           ← 构建产物，已提交进仓库；安装方加载的就是它
scripts/build-client.mjs
```

```bash
npm run build       # 由 src/client/ 生成 lib/client.js —— 改完客户端必须跑
npm test            # 150 项，无设备也能跑完（有设备时额外验证真实调用）
npm run check       # Host 半边语法检查
npm run build:check # 校验 lib/client.js 与 src/client/ 是否同步
npm run verify      # build:check + check + test（提交前跑这个）
```

> ⚠️ **改了 `src/client/` 一定要 `npm run build` 并一起提交**。
> 产物进仓库是为了让安装方（git 依赖）完全不需要工具链，代价是它会漂移 ——
> `build:check` 就是拦这个的：它重新构建一遍并与提交的产物逐字节比对，
> 不一致就失败。忘了构建而只提交源码，安装方拿到的仍是旧面板。

`lib/` 按职责分目录（`device/` 怎么跟设备说话、`stream/` 视频流链路、
`agent/` 给模型的那一面），唯一放在根下的 `client.js` 就是上面那个构建产物。

自测覆盖：二进制四级解析（含 Windows shim 回归）、adb 体检与六类失败诊断、错误归一化、令牌签名与篡改检测、loopback 围栏（含 DNS rebinding）、流格式嗅探、交互输入校验（含 swipe duration 透传）、路由匹配、显式设备 id 免枚举、judgment mobile loop 的脱敏/风险过滤/置信度/新鲜度检查、RPC 安全回退、skill frontmatter 剥离、客户端构建产物是否过期。

## 更多文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 模块划分与关键取舍
- [docs/DEPLOY-DSH.md](docs/DEPLOY-DSH.md) —— 部署到 DSH profile
- [docs/PUBLISHING.md](docs/PUBLISHING.md) —— 发版流程
- [docs/FLUTTER-TREE-RESEARCH.md](docs/FLUTTER-TREE-RESEARCH.md) —— 读 Flutter widget 树的两条路线（VM Service 直连 vs Patrol），含实测协议细节与阻塞项
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT。依赖的 [mobilecli](https://github.com/mobile-next/mobilecli) 采用 FSL-1.1-ALv2（源码公开，非 OSI 开源；内部使用属 Permitted Purpose，且每个版本满两年后自动转为 Apache-2.0）。
