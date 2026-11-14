# 更新记录

## v0.0.1 — 2026-11-14

首个可运行版本：把 Windows PC 变成 AirPlay 接收端，iPhone 屏幕镜像（含声音）过来，纯本地、不经云端。许可证 GPLv3。

### 功能

- 架构：Electron + Node.js 主进程负责界面与进程编排，UxPlay / uxplay-windows 负责 AirPlay 2 协议，GStreamer 负责解码渲染，Win32 窗口管理把视频画面放进应用窗口。Electron 不参与 H.264 解码。
- 简体中文界面：启动/停止/重启、全屏、窗口置顶、系统托盘、设置、运行日志、连接指引、单实例。
- 可配置：接收端名称、端口、分辨率、视频输出、引擎类型与路径、DPI 缩放、画面嵌入模式与延迟、额外参数。
- 三种画面嵌入模式（覆盖 / 子窗口 / 独立窗口）、「重嵌画面」按钮与托盘菜单项、`Alt+T` 恢复隐藏的工具栏。
- 工具链：`npm run check` 环境自检、`node scripts/smoke-test.js` 引擎冒烟测试（含 mDNS 探测）、`scripts/prepare-runtime.ps1` 运行时准备、`scripts/gen_assets.py` 图标生成。运行日志落盘，日志面板可直接打开。

### 关键排查与修复

- **CPU 兼容性**：开发机 Xeon E5-2689 无 AVX2，命令行 `uxplay.exe` 以 `0xC000001D` 崩溃。调试器抓到崩溃指令为 `shlx`（BMI2），反汇编统计 455 条 AVX2/BMI 指令；两个公开预编译来源同样如此。改用 CPU 可移植的 `uxplay-windows` 2.0 Qt 便携引擎作为默认引擎，命令行引擎保留给支持 AVX2 的机器。
- **服务发现**：实测 Qt 引擎能注册 `_airplay._tcp` / `_raop._tcp`，冒烟测试稳定输出「引擎持续运行 + 已检测到服务应答」。
- **GStreamer 警告**：`libgstcurl.dll` 缺 `libngtcp2` 依赖，移到 `disabled/` 后日志干净。
- **启动问题**：补装 Electron 二进制；`scripts/start.js` 清理宿主的 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`；渲染层用函数作用域避开 contextBridge 的 `api` 命名冲突。
- **首次投屏黑屏**：落盘日志 + 全量窗口枚举定位到 Qt 引擎的视频窗口（`GstD3D12Hwnd` / `AirPlay Video Stream`）创建后是隐藏的，旧枚举按 `IsWindowVisible` 过滤导致嵌入逻辑从未执行。改为按类名/标题评分识别、排除 Qt 辅助窗口、主动显示窗口。
- **工具栏隐藏后无法恢复**：新增托盘菜单项、`Alt+T` 主进程级快捷键与启动提示。

### 已知限制

- 真实 iPhone 的画面、声音与窗口嵌入效果仍需设备复测；虚拟网卡 / 多网卡环境下服务发现偶发不稳定，可重启 `Bonjour Service`。
- DRM 内容（Apple TV+、Netflix 等）无法镜像；部分 iOS 游戏不传音频；不支持 AirPlay 2 多房间音频。
- `runtime/`、`node_modules/`、`.cache/` 不纳入仓库，用 `scripts/prepare-runtime.ps1` 与 `npm install` 复现。
- 未做代码签名、安装包与自动更新；第三方组件与 GPLv3 分发义务见 `NOTICE.md`。
