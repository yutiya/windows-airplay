# 项目长期约定：免费投屏（Windows / Electron / AirPlay）

## 项目定位
Windows 10/11 上把 PC 变成 AirPlay 接收端，让 iPhone 屏幕镜像过来。免费、开源、纯本地（不经云端中转）。

## 已定技术方案
- 架构：Electron（UI / 托盘 / 设置 / 中文界面）+ Node.js 主进程（控制面：spawn、守护、日志解析、配置）+ UxPlay 独立进程（AirPlay 2 协议）+ GStreamer（d3d11videosink 视频 / wasapisink 音频）+ Win32 `SetParent` 把视频 HWND 嵌入 Electron 内容区。
- Electron 不参与解码；不使用 Electron 内置 Chromium 播 H.264。
- 许可证已定为 **GPLv3**（用户 2026-11-14 确认）：整体随 UxPlay 走 GPLv3，不再需要 MIT/Apache 的强隔离设计；对外分发须遵守源码提供与署名义务，清单见 NOTICE.md。
- 现阶段先自用跑通：不打包 GStreamer 运行时、不做安装包/签名/自动更新。
- 运行时（两套，均不进 git，用 `scripts/prepare-runtime.ps1` 复现）：
  - **默认** `runtime/qt/`：uxplay-windows 2.0.0.1736 便携包（Qt6 + libuxplay），约 255MB / 14 插件，CPU 可移植。
  - 可选 `runtime/bin/uxplay.exe` + `runtime/lib/gstreamer-1.0`：UxPlay 1.72 CLI，约 209MB / 231 插件，需 AVX2。
- 引擎选择在设置里。Qt 引擎参数写入 `%APPDATA%\leapbtw\uxplay-windows\arguments.txt`（`-n/-nh/-p/-s/-vs/-nc`），**不能传 `-as wasapisink`**（该包只有 `libgstwasapi2.dll`，会导致引擎崩溃）；Qt 引擎是 GUI 程序，终端无输出。
- 工程已落地（2026-11-14）：Electron 45.3.2 + koffi 3.3.8；主进程 IPC/托盘/状态机、UxPlay 进程守护与日志解析、Win32 SetParent 嵌入与尺寸同步、中文界面/设置/日志、自检与冒烟脚本、GPLv3 LICENSE 与 NOTICE 均完成。`npm start` 已实测可正常起窗口且无 JS 异常；`npm run check` 12 项全过。
- `npm start` 必须走 `scripts/start.js`：宿主会话带 `ELECTRON_RUN_AS_NODE=1`，直接 `electron .` 会让 require('electron') 退化为路径字符串。
- **CPU 兼容阻塞已解决（2026-11-14）**：用调试器抓到命令行 `uxplay.exe` 在 `+0x167c3` 执行 `shlx`（BMI2，机器码 `c4 e2 69 f7 d0`），capstone 线性反汇编统计出 455 条 AVX2/BMI 指令；本机 Xeon E5-2689 无 AVX2。两个公开预编译来源（uxplay-windows 1.72.1-3 安装包、saimanish1/UxPlay 1.72.2 portable）同样是 456 条，二进制补丁不可行。最终换用 uxplay-windows 2.0.0.1736 Qt 便携版：实测稳定存活、监听 7000/7001、手写 mDNS 查询收到完整 `_airplay._tcp` / `_raop._tcp` TXT 记录，`smoke-test.js` 稳定输出「引擎持续运行 + 已检测到服务应答」。命令行引擎保留给支持 AVX2 的机器。
- **dev 分支（基于 v0.0.1，2026-11-14）**：默认改为 `child` 模式，视频 HWND 真正 `SetParent` 进当前窗口，不再出现独立新窗口；`config.js` 用 `CONFIG_VERSION=2` 把旧 `owned`/1500ms 配置迁移到 `child`/600ms。投屏时舞台切成 `streamBgColor`（默认 `#000000`），画面按源宽高比居中留边（`geometry.js fitRect`），背景色作为取景框。首次投屏保护：`watch` 立即嵌入隐藏窗口 + `embedguard.js` 每 200ms 校验父子关系/可见性/几何，600ms 后仍隐藏就主动显示并重绘；引擎重启靠 `UxPlayEngine` 的 `started` 事件重挂 watcher。`npm run test:firstcast` 22 项是首次投屏黑屏的回归测试，改动显示链路后必须重跑。
- **真机复测已通过（2026-11-14 22:33，iPhone12,1）**：用户反馈「没有问题」——第一次投屏即有画面、在当前窗口内、无独立新窗口、无需重连第二次。日志实证引擎的视频窗口自始至终 `vis=false`，是应用的「首帧保护」主动显示并重绘才出画面，这就是 v0.0.1 首次黑屏缺的那一环。诊断时按「候选窗口是否枚举到 → 是否已嵌入当前窗口 → 是否首帧保护」三段日志定位。
- **仍未逐项复核**：背景色与留边观感、声音、全屏/置顶时的位置尺寸同步（用户本轮未反馈异常）。虚拟网卡/多网卡环境下 mDNS 只读查询偶发收不到应答，可重启 `Bonjour Service`。

## 范围边界
- MVP：屏幕镜像 + 声音、全屏、置顶、托盘、简体中文界面。
- 明确不做：PIN/密码、开机自启、截图、录屏、多设备同投、OBS/虚拟摄像头、USB 有线投屏、Microsoft Store 上架。
- 已知不可解：DRM 内容（Netflix/Apple TV+）无法镜像；部分 iOS 游戏不传音频；AirPlay 2 多房间音频不支持；需同局域网且网络为「专用」、首次运行需手动放行防火墙。

## 工程约定
- 代码/注释用简体中文与用户沟通；代码标识符、配置文件、命令一律 ASCII 直引号。
- 依赖 UxPlay 上游（FDH2/UxPlay），iOS 大版本升级后需跟随升级验证。
