# 变更日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)，
变更记录格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

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
