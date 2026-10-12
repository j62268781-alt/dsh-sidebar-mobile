# 部署到 DSH

本插件是标准的 DSH 插件（`dsh.bundle.patch` 指向 `cordis.patch.yml`，带 `dsh.client` 声明），走官方加载路径。

## 前提

| 项 | 要求 | 检查 |
|---|---|---|
| DSH | ≥ 0.2.0-0，带 web bundle | `dsh --version` |
| Node | ≥ 20 | `node -v` |
| mobilecli | 任意近期版本 | `mobilecli --version` |
| adb（Android） | 在 PATH 或 `ANDROID_HOME` 下 | `adb devices` |
| Xcode（iOS） | **完整 Xcode**，不只是 Command Line Tools | `xcrun simctl list devices` |

`mobilecli` 没装也能跑插件（工具会给出安装提示），但面板不会有画面。

## 安装到 web profile

```bash
npm install -g mobilecli@latest

dsh plugin --profile web add @j62268781-alt/dsh-sidebar-mobile@latest
dsh web
```

刷新页面 → 右侧边栏出现「移动设备」。

## 安装到 desktop profile

`desktop` profile 由桌面应用独占，宿主 CLI 的 `dsh plugin --profile desktop` **会被直接拒绝**。桌面端走：

**设置 → 插件市场** → 搜 `dsh-sidebar-mobile` → 安装 → 刷新。

## 从源码（开发）

### ⚠️ 必须用真实目录，不能用软链

本插件的 Host 半 import 宿主包（`@deepseek-ai/dsh-tools`），而那些包**由 DSH 运行时提供、不在 profile 的 `node_modules` 里**。DSH 用自己的私有解析器把这类 import 路由到运行时。

**软链会破坏这个解析**：Node 的 ESM 解析默认 `preserveSymlinks=false`，会以软链的**真实路径**为基准往上找 `node_modules`。源码目录在 `~/Documents/...` 下，那里没有 `@deepseek-ai/*`，于是报：

```
dsh-sidebar-mobile (@j62268781-alt/dsh-sidebar-mobile): failed to import
```

**实测对照**（同一个插件）：

| 安装方式 | 结果 |
|---|---|
| `ln -s` 软链 | ❌ `failed to import` |
| 真实目录复制 | ✅ 正常加载 |

同一个 profile 里 `dsh-hindsight-bank-router` 用软链没问题，是因为它 `inject = []`、不 import 任何宿主包——**软链本身不是问题，"软链 + import 宿主包"才是**。

### 正确做法：用 `file:` 协议

```bash
git clone https://github.com/j62268781-alt/dsh-sidebar-mobile.git
cd dsh-sidebar-mobile

dsh plugin --profile web add "file:$PWD"
```

`file:` 让 pnpm **复制**目录（真实目录），而 `link:` 建的是**软链**——后者正是会触发 `failed to import` 的那种。

**实测验证**（`file:` 装上后跑 `CI=true pnpm install --no-frozen-lockfile` 重建）：

| 协议 | pnpm 重建后 | 结果 |
|---|---|---|
| `link:` | 软链 | ❌ `failed to import` |
| `file:` | 真实目录 | ✅ 正常加载 |

`file:` 装出来的是干净的副本：文件完整、不含 `.git`、lockfile 记录正确。

### 改完源码后

```bash
cd ~/Documents/dsh-plugins/dsh-sidebar-mobile
dsh plugin --profile web add "file:$PWD"     # 重新复制
```

或在 profile 里直接覆盖（更快）：

```bash
PROFILE=~/.dsh/profiles/web
cp -R ~/Documents/dsh-plugins/dsh-sidebar-mobile/. \
      "$PROFILE/node_modules/@j62268781-alt/dsh-sidebar-mobile/"
```

> 若用 `cp -R` 且源目录带 `.git`，只读的 git 对象会报 `Permission denied`——**不影响插件**（那些是版本控制元数据，运行时用不到）。想避免噪音就在复制时排除：`cp -R` 前先 `git archive` 导出干净树，或用 `file:` 协议。

然后把包名追加进 `$PROFILE/package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@j62268781-alt/dsh-sidebar-mobile"
      ]
    }
  }
}
```

改完源码要重新复制一次（`cp -R` 覆盖）：

```bash
cp -R "$PWD" "$PROFILE/node_modules/@j62268781-alt/dsh-sidebar-mobile"
```

重启 `dsh web`。Host 侧改动需要重启；客户端改动**刷新页面即可**（单文件、无构建步骤）。

> 发到 npm 之后走 `dsh plugin --profile web add @j62268781-alt/dsh-sidebar-mobile@latest` 不受此影响——pnpm 装的是真实目录。

### 从源码时的自查

```bash
dsh web --port 3091 --no-open 2>&1 | grep -E "sidebar-mobile|failed"
```

出现 `sidebar-mobile ... failed to import` 就是软链的问题；正常加载时这一行**不会出现**。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-sidebar-mobile
  config:
    enabled: true
    binaryPath: null        # 自动解析；解析不到时工具会给安装提示
    homeDir: null           # 用 mobilecli 默认的 ~/.mobilecli
    registerSkills: true

    stream:
      idleStopSeconds: 300
      restartDelayMs: 5000
      defaultScale: 1.0     # 0.5 可显著降带宽（iOS 实测 6.6Mbps vs 20.6Mbps）

    panel:
      defaultSize: fit
      defaultFrame: bezel

    trustedAuthorities: []  # 反向代理场景才需要
```

## 经反向代理访问

若 DSH 本身经反向代理对外（例如用 `dsh-pocket` 做局域网/公网访问），来自浏览器请求的 `Host` 头是对外的域名，而不是 loopback。默认情况下这类请求会被围栏拒绝（403）。

把对外 authority 显式列出来即可：

```yaml
    trustedAuthorities:
      - dsh.example.com              # 任意 Host 端口
      - dsh.example.com:8443         # 精确匹配
      - https://dsh.example.com:8443 # 同时钉住 scheme
```

语义与 `dsh-android` 的 `trustedAuthorities` 一致，两处写法可以照搬。

> ⚠️ **只在该代理对每个插件路由都做了鉴权时才配置**。`Origin` 是浏览器的保护，不是鉴权——非浏览器客户端可以同时伪造 `Host` 和 `Origin`。对端地址围栏始终强制，所以直连的非 loopback 客户端无论如何都会被拒。
>
> 一个例外：服务端日志里会出现 `/grant` 这类请求。它们带 `Origin`（POST 都要求），但没有额外鉴权。

## 多设备 / 多 profile

同一台机器上跑多个 DSH 进程时，**不要让它们共用一个 mobilecli daemon**（device 会被互相抢）。给每个 profile 配独立的 `homeDir`：

```yaml
# profile A
    homeDir: ~/.mobilecli-a
# profile B
    homeDir: ~/.mobilecli-b
```

## 卸载

```bash
dsh plugin --profile web remove @j62268781-alt/dsh-sidebar-mobile
```

插件卸载时：

1. 注销 16 个工具与 skill
2. 摘掉流路由
3. **停掉所有流子进程**（否则设备会一直编码，耗电并占用 USB 带宽）

mobilecli 的 daemon 不会被自动停掉（它由 mobilecli 自己管理，30 分钟空闲自退出）。需要立刻回收设备给其它工具时：

```bash
mobilecli daemon stop
```

这也会释放设备端独占的 UiAutomation——Appium 之类的工具在 daemon 停止后立刻恢复可用。

## 排障

| 症状 | 原因与处理 |
|---|---|
| 面板显示「未发现设备」 | 模拟器没启动，或真机没授权。`mobilecli devices` 先确认 |
| 画面一直「正在连接设备…」 | 首次要在设备上拉起 agent，可能几秒；iOS 模拟器需先 `mobilecli agent install` |
| `取流失败（HTTP 403）` | 经代理访问但 `trustedAuthorities` 没配 |
| `取流失败（HTTP 401）` | 令牌过期（10 分钟）。点 ⟲ 重新申请 |
| `此浏览器不支持 WebCodecs` | H.264 路径需要较新的 Chrome/Edge，且必须从 HTTPS 或 localhost 打开 |
| 点击位置偏移 | 检查是否在画面黑边上点（黑边事件被忽略）。若整个画面偏移，说明缩放计算有问题 |
| 工具全报「mobilecli 不可用」 | 装它：`npm i -g mobilecli@latest`，或配 `binaryPath` |
| `uiautomator dump` 失效 | 这是已知边界：mobilecli 独占 UiAutomation。`mobilecli daemon stop` 后恢复 |
| 启动日志出现 `failed to import` | 从源码装时用了软链。改用真实目录复制，见[从源码](#从源码开发) |
| 启动日志出现 `1 entry did not activate` | 同上——就是本插件没激活。这条警告是它的表现 |
