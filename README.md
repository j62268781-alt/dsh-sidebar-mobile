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
- 🧰 **16 个模型工具**：读 UI 树、按标识点元素、启动应用、读日志、等文本出现
- 📱 **一套 API 两端通用**：真机、模拟器、模拟机走同一条路径，没有平台分支
- 🐦 **能读 Flutter 的真实 widget 树**：绕过无障碍投影，直连 Dart VM Service
- 🎓 **自带 mobilecli 的 skill**：把上游 playbook 打包注册给模型，不用自己往 `.agents/` 抄
- 🔐 **浏览器从不接触设备端口**：只经 DSH 自己的 web 源，签名令牌 + loopback 围栏
- 📦 **零运行时依赖**：`react` 用宿主那份，客户端单文件、无需构建

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

更关键的是另一件事：**它能读 Flutter 的真实 render tree**。Flutter 把整个 UI 画进一块不透明的原生 view，无障碍树只能看到应用主动投影出去的那部分（合并过的、丢类型的，`CustomPaint` 画的图表直接消失）。mobilecli 通过 Dart VM Service 直读渲染树，拿得到 widget Key、控件状态、自绘内容——**这是现成插件都没有的能力**。

## 安装

### 前置：mobilecli

```bash
npm install -g mobilecli@latest
mobilecli devices          # 确认能看到设备
```

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

装完刷新页面，右侧边栏出现「移动设备」tab。

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
| `stream.idleStopSeconds` | `300` | 无消费者后多久停流 |
| `stream.restartDelayMs` | `5000` | 流崩溃后的重启延迟 |
| `stream.defaultScale` | `1.0` | 缩放。`0.5` 在 iOS 上实测 104fps/6.6Mbps（全分辨率 131fps/20.6Mbps） |
| `trustedAuthorities` | `[]` | 经反向代理访问时显式列出对外 authority |

`binaryPath` 为 `null` 时的**四级解析**顺序：

1. `MOBILECLI_PATH` 环境变量
2. `PATH` 上的 `mobilecli`（`npm -g` 装的 shim）
3. 本包 `node_modules` 里的平台包（`@mobilenext/mobilecli-<os>-<arch>`）
4. 全落空 → 工具仍注册，调用时给出安装提示（而不是插件加载失败）

## 使用

### 面板

右侧边栏 →「移动设备」：

- **设备下拉**：列出全部设备，离线设备标注「（离线）」
- **⌂ / ◁ / ⟳**：主屏幕 / 返回（仅 Android）/ 旋转
- **⟲**：重新申请令牌并重连（画面卡住时用）
- **▢ / ▣ / ▤**：切换外观（边框 / 真机 / 无框）
- **在画面上点击** → 点设备的对应位置；**拖拽** → 滑动

状态栏显示 `实时/未串流`、平台、以及实际拿到的流格式（`H.264` 或 `MJPEG`）。

### 模型工具

| 工具 | 用途 |
|---|---|
| `mobile_devices` | 列出所有设备（**先跑这个**拿到 device id） |
| `mobile_boot` | 启动设备并开始串流（画面出现在面板） |
| `mobile_ui_tree` | **读界面首选**：类型、文本、identifier、坐标 |
| `mobile_screenshot` | 截图（给人或多模态模型看，不是读界面的首选） |
| `mobile_tap` / `mobile_swipe` | 坐标操作 |
| `mobile_tap_element` | **按标识/文本点元素**（比坐标稳，可带 `expect_text` 一并验证） |
| `mobile_type_text` | 输入文本（**需先点输入框获得焦点**） |
| `mobile_press_button` | HOME / BACK / POWER / 音量 / ENTER / APP_SWITCH |
| `mobile_list_apps` / `mobile_launch_app` | 列应用 / 启动应用 |
| `mobile_find_text` / `mobile_tap_text` | OCR 找文字 / 点文字（树读不到时的兜底） |
| `mobile_wait_for` | 等文本出现或消失 |
| `mobile_logs` | 读设备日志（logcat / unified log） |
| `mobile_flutter_tree` | **读 Flutter 真实 widget 树**（需 debug 构建） |

工具描述里写明了"先用哪个、什么时候升级到下一个"，因为三种观察方式的代价差一个数量级：

```
mobile_ui_tree    ~100–300ms   结构化，首选
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
- **⚠️ `--fps` 参数当前不生效**。实测请求 15 与 30 都得到 ~104fps。想降带宽只能用 `--scale`。
- **⚠️ iOS 的 `--format avc` 会被静默降级成 MJPEG**。这也是本插件从首块字节嗅探格式、而不相信请求参数的原因。
- **⚠️ Flutter render tree 需要 debug 构建**。JVMTI 只能 attach 可调试的应用；release/profile 会退回无障碍树。
- **iOS 真机的 Flutter 支持未验证**。已知的 Flutter 实现在模拟器路径上；真机走 WDA + LLDB 注入。
- **多个 DSH 进程不能共用同一个 daemon**。需要并行时给每个 profile 配不同的 `homeDir`。
- **⚠️ 从源码装时不能用软链**。本插件的 Host 半 import 宿主包（`@deepseek-ai/dsh-tools`），而 Node 的 ESM 解析会以软链的**真实路径**为基准去找 `node_modules`——源码目录下没有那些包，于是启动日志报 `failed to import`（伴随 `1 entry did not activate`）。**实测对照**：同一个插件软链失败、真实目录成功。用 `dsh plugin add "link:$PWD"` 或 `cp -R` 成真实目录，见 [docs/DEPLOY-DSH.md](docs/DEPLOY-DSH.md)。发到 npm 后不受影响。

## 自测

```bash
npm test          # 43 项，无设备也能跑完（有设备时额外验证真实调用）
npm run check     # 语法检查
npm run verify    # 两者都跑
```

自测覆盖：二进制四级解析、错误归一化、令牌签名与篡改检测、loopback 围栏（含 DNS rebinding）、流格式嗅探、交互输入校验、路由匹配、skill frontmatter 剥离。

## 更多文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 模块划分与关键取舍
- [docs/DEPLOY-DSH.md](docs/DEPLOY-DSH.md) —— 部署到 DSH profile
- [docs/PUBLISHING.md](docs/PUBLISHING.md) —— 发版流程
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT。依赖的 [mobilecli](https://github.com/mobile-next/mobilecli) 采用 FSL-1.1-ALv2（源码公开，非 OSI 开源；内部使用属 Permitted Purpose，且每个版本满两年后自动转为 Apache-2.0）。
