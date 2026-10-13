# 读 Flutter widget 树：两条路线的调研

面向要动这块的人。结论先行：**两条路线解决的是两个不同问题，不是替代关系。**

- **VM Service 直连** —— **现场观测**："现在屏幕上是什么"
- **Patrol / integration_test** —— **脚本化复现**："跑我写好的这个流程"

调研日期 2026-10-13，实测设备：一加 12 / Android 16；被测应用
`com.dycjr.jg.inner`（工程 `tcl_jiguang`，本机 `/Users/joeson/Documents/tcl_jiguang`）。

---

## 0. 为什么要调研这个

`mobile_flutter_tree` 的工具描述写着：

> 读 Flutter 应用的**真实 widget 树**——绕过无障碍投影，**直连 Dart VM Service**

**但它的实现只是 `dump ui` 的副本。** `flutterTreeTool.execute` 调的是
`dumpUiElements(client, id)`，而 `mobile_ui_tree` 调的**是同一个函数**，
内部都是：

```js
client.runJson(["dump", "ui", "--device", deviceId, "--format", "json"])
```

`mobilecli dump ui --help` 里**没有任何 Flutter 选项**（只有
`--device` / `--format json|text|raw` / `--full`），CLI 里也没有 `flutter` 命令，
daemon 的 `device.flutter.vmServiceUri` 返回 `method not found`。

### 结论：该工具**已删除**

一个**描述骗人的工具比没有这个工具更糟** —— agent 会以为读到了 Flutter 树
并据此下结论。它同时还与 `mobile_ui_tree` 完全重复，白占约
**124 tokens/轮** 的 schema 成本（11 个工具 1034 → 10 个 910，实测）。

名字保留在 `REMOVED_TOOL_NAMES` 里（本仓库惯例），这样调用方拿到
`mobile_flutter_tree is not a tool` 时能分辨"插件删了它"和"名字打错了"。

**替换路径**：真要读 Flutter widget 树，走下面两条路线之一，本插件不再实现。


### 实测：它拿到的是什么

对上述应用（**确实是 Flutter**，APK 里有 `assets/flutter_assets/`）执行
`dump ui --format json`，得到 **69 个节点，全部 `type` 都是 `android.*`**：

| 部分 | 节点数 | 内容 |
|---|---|---|
| systemui 状态栏 | 32 | 时间、网速、wifi、电池 —— **系统 UI，不是被测应用** |
| 应用窗口（`content` 下） | 37 | **全是匿名 `View`/`ImageView`，只有 `rect`，无 text / identifier** |

应用那部分长这样：

```
content                    1080x2376 @0,0
  View                     1080x2208 @0,0
    ImageView               984x367 @48,120
    View                    360x147 @0,487
    View                    123x48 @69,889
    View                   1080x648 @0,959
```

**这正是 Flutter 在无障碍层的投影**：整屏画出来的东西没有语义，只有矩形。
所以这份"树"对要看懂界面结构几乎没有价值 —— 描述承诺的恰是"绕过无障碍投影"，
而它没有绕过。

### 为什么会这样：Flutter 的语义树**默认根本不生成**

这一点最初被误判为"Flutter 不可测"。实测把它纠正了 —— Flutter 自己会告诉你：

```
$ curl ".../ext.flutter.debugDumpSemanticsTreeInTraversalOrder?isolateId=..."
Semantics not generated for _ReusableRenderView#35615.
For performance reasons, the framework only generates semantics when asked
to do so by the platform. Usually, platforms only ask for semantics when
assistive technologies (like screen readers) are running.
To generate semantics, try turning on an assistive technology (like TalkBack).
```

配合设备状态一起看就完整了：`accessibility_enabled = 0`、**零个无障碍服务在跑**
—— 所以语义树从未生成，`dump ui` 自然只能看到匿名 view。

**那么"开启 TalkBack 再读 a11y 树"是不是一条可行的替代路线？实测后不推荐。**

短暂启用 TalkBack（`settings put secure enabled_accessibility_services
com.google.android.marvin.talkback/.TalkBackService`）后重新 dump，树确实变了：

| | 拍平节点 | 有文字 | 有 identifier |
|---|---|---|---|
| TalkBack 关闭 | 69 | 3（全是 systemui） | 34 |
| TalkBack 开启 | 68 | 11 | 61 |

**但多出来的文字全是 TalkBack 自己的引导页** —— `TalkBack 已开启` /
`关闭 TalkBack` / `欢迎使用 TalkBack` / `第 1 页，共 7 页`。它把前台抢走了，
所以这次测量**没能验证到应用自身的语义树是否填充**（要验下去得先闯过 7 页设置向导）。

而"得先闯过设置向导"**本身就是反对这条路的证据**：作为产品能力，它需要
**改变用户设备的无障碍状态**、会让手机开始朗读、还会把触控变成"单击选中、
双击激活"。不可接受。Patrol 完全不需要碰这些。

> 复现步骤、以及本次为避免残留做了什么恢复（音量/无障碍开关/前台应用），
> 见文末附录。


---

## 1. 路线 A：直连 Dart VM Service（现场观测）

### 1.1 前提：必须是 **debug** 构建

| 判据 | 命令 | 实测结果 |
|---|---|---|
| debuggable | `dumpsys package <pkg> \| grep flags=` | `flags=[ DEBUGGABLE HAS_CODE ... ]` |
| 有无 AOT 快照 | `unzip -l base.apk \| grep libapp.so` | **没有 `libapp.so`**，只有 `libflutter.so` → JIT = debug |

release 构建是 AOT（有 `libapp.so`），**不带 VM Service**，这条路走不通。

### 1.2 找端口：**不需要鉴权码**

debug 的 Flutter 引擎在**设备内**监听 `127.0.0.1:<port>`。扫应用 uid 的
`/proc/net/tcp` 即可：

```
sl  local_address rem_address   st tx_queue rx_queue ... uid
0:  0100007F:B301 00000000:0000 0A ...                    10825
     └ 127.0.0.1   └ 45825      └ LISTEN                  └ 应用 uid
```

`0100007F` 是小端表示的 `127.0.0.1`，`0A` 是 `LISTEN`。
uid 从 `/proc/<pid>/status` 的 `Uid:` 行取，pid 从
`dumpsys activity activities` 的 `topResumedActivity` 取。

> ⚠️ 用 `topResumedActivity`，**不要**用 `dumpsys window` 的 `mCurrentFocus` ——
> 实测后者在这台机器上返回 `null`，即使屏幕亮着、应用在前台。

### 1.3 找鉴权码：**这是唯一的痛点**

引擎只在 **App 启动那一刻**往 logcat 打一行：

```
I/flutter: The Dart VM service is listening on http://127.0.0.1:42123/FD8A2x4kjnk=/
```

App 跑久了这行会滚出缓冲区，**之后就再也拿不到**。实测找过、都没有：

- 全缓冲区 logcat（`-b all`，31026 行，覆盖了应用启动时刻）
- 应用私有数据（`run-as` 全目录 grep）
- `/proc/<pid>/environ`
- 主机侧 mDNS（`dns-sd -B _dartVmService._tcp`）

应用运行 3.03 小时那次，启动时刻 13:53 的日志有 202 行，**没有那行**。

### 1.4 三个"写错就静默失败"的协议细节

**① URL 路径里的 token 必须带结尾的 `=`**

```
/FD8A2x4kjnk=/getVM   → HTTP 200  ✅
/FD8A2x4kjnk/getVM    → HTTP 403  ❌
```

**② inspector 扩展的参数名是 `objectGroup`，不是 `groupName`**

传 `groupName` 会报 `Null check operator used on a null value`。

**③ 不能用 `debugDumpApp` 当工具结果**

| 扩展 | 实测体积 |
|---|---|
| `ext.flutter.debugDumpApp` | **6 628 781 字符** |
| `ext.flutter.inspector.getRootWidgetSummaryTree` | **2 407 206 字符 / 4921 节点** |

两者都远超工具结果该有的量级，必须裁剪。`debugDumpApp` 的文本格式可读性最好
（能看到 `RichText(text: "待处理（8360）")` 这类真实文案），适合给人看；
`getRootWidgetSummaryTree` 结构化，适合做程序处理。

### 1.5 最有价值的字段：`creationLocation`

摘要树每个节点都带：

```json
{
  "widgetRuntimeType": "AnimatedContainer",
  "creationLocation": {
    "file": "file:///Users/joeson/Documents/tcl_jiguang/lib/v2/.../animation_panel.dart",
    "line": 28, "column": 12, "name": "AnimatedContainer"
  },
  "stateful": true,
  "valueId": "inspector-401"
}
```

**这能把屏幕上每个 widget 映射回源码。** 实测该应用树里涉及 **94 个源文件**，
其中应用自己的代码（排除 `/flutter/lib/`、`/packages/flutter/`、`.pub-cache/`）
约占一半：

| 节点数 | 归属 | 文件 |
|---|---|---|
| 1127 | 第三方包 | `vector_graphics-1.2.3/lib/src/vector_graphics.dart` |
| 336 | **应用** | `lib/view/todo/widget/cert_update_todo_item_widget.dart` |
| 308 | **应用** | `lib/v2/features/order/order/widgets/dealer_order_card.dart` |
| 264 | **应用** | `lib/v2/features/internal/data/funnel/inner_analysis_funnel_page.dart` |
| 193 | **应用** | `lib/v2/features/internal/data/inner_data_page.dart` |

抽查的 4 个文件在 `/Users/joeson/Documents/tcl_jiguang` 下**全部存在** ——
也就是说这条路不只是"看一棵树"，而是**实时界面 ↔ 源码**的直接映射。

### 1.6 为什么需要一张判定表

这条路的失败模式**不是报错，而是静默给出错误的树**：应用不是 debug、
或没抓到鉴权码时，随手退回无障碍树，使用者会以为读到了 Flutter 树。

所以「观测到什么 → 走哪条路」应当写成**显式表**，命中后**连同理由一起返回**：

| 观测到 | 策略 |
|---|---|
| 前台不是 Flutter（进程无 `libflutter.so`） | 明确说不是 |
| 是 Flutter 但 release（无 `libapp.so` / 非 DEBUGGABLE） | 说清 release 无 VM Service |
| debug + 端口在 + 抓到 token | **走 VM Service** |
| debug + 端口在 + token 丢 | 说"重启 App 即可"，并给出为什么 |
| 端口在但 403 | 区分"token 过期"（App 重启过）vs 服务问题 |
| 非 Android | 目前只实现了 Android 的发现 |

### 1.7 官方 `dart mcp-server` 绕不过去（实测）

Flutter 3.38 自带 `dart mcp-server`（26 个工具），**有 `get_widget_tree`**，
但实测它解决不了：

| 实测 | 结果 |
|---|---|
| `list_running_apps` | **`Found 0 running applications.`** —— 看不到手动启动的 App |
| `get_widget_tree` | `The dart tooling daemon is not connected, you need to call "connect_dart_tooling_daemon" first.` |
| `connect_dart_tooling_daemon` | 参数 `{"uri": ...}`，**required** |

它的描述写得很清楚：`list_running_apps` 只返回 **"apps started by the
launch_app tool"**。而 `launch_app` 需要 Flutter **工程根目录**（本质是替你跑
`flutter run`）——**由它启动，它才知道 URI**。

对"从桌面点图标启动"的 App，**它同样需要你提供 URI**，鸡生蛋问题没解决。

> 参考：`flutter attach` 在 Android 上找 URI 用的**也是扫 logcat**。
> 这不是实现偷懒，是 Android 上独立启动的 Flutter App 就这么暴露自己。

---

## 2. 路线 B：Patrol / integration_test（脚本化复现）

### 2.1 这条路确实绕开了鉴权码

工具链（`patrol` CLI / `flutter test` / integration_test）**自己构建、自己安装、
自己持有会话**，所以 "该连哪个 VM Service" 这个问题**消失了** ——
不需要判定表，因为不需要在信息不全时选路。

### 2.2 但它是"构建并安装一个测试版 App"，不是"附着到正在跑的那个"

`patrol test` 的选项确认了这一点：`--debug`（默认）/ `--profile` / `--release`、
`--flavor`、`--dart-define` —— 它是**构建**。

后果：

- 会**覆盖设备上正在跑的那个 App**（同包名重装），应用重启
- 任何状态必须**用代码走到**（登录、导航），不能"观察当前"
- **必须有工程源码**，第三方 App 无法使用

### 2.3 `patrol_mcp`：给 agent 的现成驱动

pub.dev 上 **`patrol_mcp` 0.2.1**（LeanCode 官方）：

| 工具 | 作用 |
|---|---|
| `run` | 跑一个测试文件并等完成；自动选设备（Android 真机 > 模拟器 > iOS） |
| `devices` | 列出设备 |
| `status` / `quit` | 会话状态 / 优雅退出 |
| `screenshot` | 从活动会话截图 |
| `native-tree` | 读原生 UI 树 |

**Features 里的关键一句：**

> **Keep and reuse a develop session for hot-restart workflows.**

它包的是 **`patrol develop`** —— **一次构建、之后热重启**。这才是"更快"的真正
来源：不必每次改动都重新 build + install。

### 2.4 目标工程已经有成套测试资产

`tcl_jiguang` 已有：

```
integration_test/app_smoke_test.dart       启动到稳定入口（login / dealer / internal 三种）
integration_test/logout_smoke_test.dart
integration_test/support/    guarded_patrol_test.dart · wait_until.dart
                             native_permissions.dart · blocking_ui_guard.dart
integration_test/fixtures/   test_environment.dart · test_users.dart
.agents/skills/patrol-{setup,write-test,test-architecture}/SKILL.md
```

pubspec 里 `patrol: 4.5.0` + `patrol: test_directory: integration_test`。
测试**靠 Key 找元素**（`$(AppKeys.loginWelcomeText)`），这是硬前提 ——
**要给元素埋 Key 才能测**。

### 2.5 实测的阻塞项

| 问题 | 证据 |
|---|---|
| **Patrol 版本不匹配** | CLI **3.11.0** vs pubspec **patrol 4.5.0**；Patrol 要求二者匹配 |
| **`patrol_mcp` 需要更新 CLI** | 它依赖 **`patrol_cli ^4.8.0`**，本机 3.11.0 |
| **`patrol_mcp` 未引入** | pubspec / pubspec.lock 里都没有 |
| **环境未就绪** | `patrol doctor`：`$ANDROID_HOME` 未设；`ideviceinstaller` 缺（iOS 用） |

修法：

```bash
patrol update                          # CLI 升到 4.8+
cd /Users/joeson/Documents/tcl_jiguang
dart pub add --dev patrol_mcp
# 然后配 MCP：command=dart  args=["run","patrol_mcp"]  env.PROJECT_ROOT=.
```

---

## 3. 对比

| | VM Service 直连 | Patrol / patrol_mcp |
|---|---|---|
| 回答的问题 | **现在**屏幕上是什么 | 跑我写好的流程 |
| 鉴权码 | **要抓，且只在启动时出现**（唯一痛点） | 不需要（工具链自己持有） |
| 是否需要工程源码 | 否（任意 debug Flutter App） | **是** |
| 找元素 | 遍历真实树 | 必须预先埋 **Key** |
| 是否改动设备上的 App | 否 | **是**（重新构建 + 安装） |
| 迭代速度 | 即时（刷新/重连） | 首次构建慢；`patrol develop` 热重启后快 |
| 能驱动原生弹窗 | 否 | 是（`$.platform`） |
| 可进 CI | 不适合 | **是**（本来就是为此设计） |
| 能映射回源码 | **是**（`creationLocation.file:line`） | 是（本来就写在源码里） |

**结论：互补，不替代。** 对 `dsh-sidebar-mobile` 来说这是**两个功能**，
不该混进同一个工具：

- `mobile_flutter_tree` 保持"现场观测"，配判定表
- Patrol 集成是**新增能力**，更适合做成 skill（+ 包一层 `patrol_mcp`）

---

## 4. 建议

1. **本插件不再自带 Flutter 树能力**（`mobile_flutter_tree` 已删除）。
   两条路线都属于**别的工具**的职责，塞进本插件只会重复且说谎。
2. **首选 Patrol / `patrol_mcp`**（脚本化自动化）。对本插件面向的场景
   （自己的 App、可复现流程、要进 CI）它明显更优：有断言、有 Key 定位、
   能控系统开关、有测试运行器。**但先修版本不匹配**，否则后面全是假故障。
3. 要**现场观测**（"现在屏幕上是什么"）时才走 VM Service。那时**判定表是必需的**
   —— 否则会静默给出错误的树，比报错更糟。
4. 若目标应用是自己人写的（如 `tcl_jiguang`），**`creationLocation` ↔ 本机源码**
   是最有价值的产出 —— 值得单独做个能力。
5. 若在 `tcl_jiguang` 工作区，**优先用已经配好的 `dart-mcp-server`** 的
   `get_widget_tree`：它由 `launch_app` 自行持有 URI，**不需要抓鉴权码**。
   ⚠️ 但它 26 个 schema 常驻约 **6867 tokens/轮**（是本插件全部 10 个工具的
   7.5 倍），建议用 `--exclude-tool` 排掉与 shell 命令等价的那些。

---

## 附：原型与复现

### `docs/prototypes/flutter-vm.js`（未接线，仅供参照）

调研期间写过一份原型，含：

- 判定表 `FLUTTER_RULES` / `decideFlutterStrategy()`（纯函数，可单测）
- 三个纯解析器：`parseVmServiceUri()` / `findVmServicePort()` / `isFlutterProcess()`
- 裁剪器 `shapeWidgetTree()`（`scope: app|all` + `maxNodes`/`maxDepth`）
- IO 层 `FlutterVm`（adb 探测 → forward → VM Service RPC）

**它从未接线，也随着 `mobile_flutter_tree` 的删除而失去归宿。** 保留下来仅为
记录"这个方案长什么样"；如果要重做，上面的协议细节比这份代码更值钱。

⚠️ **为什么放在 `docs/prototypes/` 而不是 `lib/`**：`package.json` 的 `files`
含 `lib` 但不含 `docs`。它没有任何调用方，放进 `lib/` 就会**随包发布 21.6 kB
的死代码**给每一个安装者（`npm pack` 实测确认过）。放这里既能留档，又不进包。


### 复现本次调研的关键命令

```bash
PKG=com.dycjr.jg.inner

# 1) 是不是 debug Flutter
adb shell dumpsys package $PKG | grep -o 'flags=\[[^]]*\]'   # 要含 DEBUGGABLE
adb shell pm path $PKG                                        # 取 APK 路径
adb shell "unzip -l <apk> | grep -E 'libapp.so|libflutter.so'" # 无 libapp.so = debug

# 2) 端口（不需要 token）
PID=$(adb shell pidof $PKG)
adb shell "cat /proc/$PID/status" | grep '^Uid:'              # 取 uid
adb shell "cat /proc/net/tcp" | awk '$4=="0A"'                # 找该 uid 的 LISTEN

# 3) 鉴权码（必须趁 App 刚启动）
adb logcat -c && adb shell am force-stop $PKG
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1
adb logcat -d | grep -oE 'http://127\.0\.0\.1:[0-9]+/[A-Za-z0-9_=-]+/'

# 4) 连上去（⚠️ token 的结尾 = 要留着）
adb forward tcp:<port> tcp:<port>
curl "http://127.0.0.1:<port>/<token>=/getVM"                 # 200 才算通
curl "http://127.0.0.1:<port>/<token>=/ext.flutter.inspector.getRootWidgetSummaryTree?isolateId=<iso>&objectGroup=probe"
```
