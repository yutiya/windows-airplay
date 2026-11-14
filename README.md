# 免费投屏

Windows 上免费、开源、纯本地的 iPhone AirPlay 投屏接收端。基于 Electron + Node.js + uxplay-windows（UxPlay）+ GStreamer，**GPLv3**。

## 它是什么

把 PC 变成一个「Apple TV」：iPhone 在控制中心的「屏幕镜像」里能直接看到这台电脑，画面和声音实时过来，不经过任何云端。

```
iPhone ──同一 Wi-Fi / AirPlay 2──> AirPlay 引擎（发现 · 配对 · FairPlay 解密 · RTP）
                                      │
                                      ├─> GStreamer：H.264 → D3D11 视频窗口
                                      └─> GStreamer：AAC/ALAC → WASAPI 音频
                                                │
Electron 窗口  <── Win32 SetParent 嵌入视频 HWND ──┘
     ▲
     └── Node.js 主进程：spawn / 守护 / 日志解析 / 配置 / 托盘
```

Electron 只负责界面与进程编排，**完全不参与解码**，因此绕开了 Chromium 对 H.264 编解码与专利构建的限制。

## 功能范围

已实现：屏幕镜像 + 声音、全屏、窗口置顶、系统托盘、简体中文界面、接收端配置（名称/端口/分辨率/视频输出）、运行日志、引擎崩溃自动重启、单实例、两种引擎切换。

明确不做（MVP 边界）：PIN/密码、开机自启、截图、录屏、多设备同投、OBS/虚拟摄像头、USB 有线投屏、Microsoft Store 上架、安装包与自动更新。

## 环境要求

- Windows 10 / 11 x64
- Node.js 18+（开发时）
- **Bonjour Service 正在运行**（AirPlay 的服务发现依赖它；通常随 iTunes / Apple 软件安装）
- iPhone / iPad 与电脑在同一局域网，电脑网络类型为「专用」
- 首次运行需在防火墙弹窗中允许访问（专用网络）
- iOS 12+ / iPadOS 13+
- **CPU 无特殊要求**：默认引擎兼容不支持 AVX2 的老 CPU

## 快速开始

```bash
npm install
npm run check                 # 环境自检（只读）
npm run test:firstcast        # 首次投屏回归测试（窗口层，无需 iPhone）
node scripts/smoke-test.js    # 启动引擎 9 秒，验证存活 + mDNS 服务注册
npm start                     # 启动应用
```

`npm start` 走 `scripts/start.js`：它会清理宿主环境可能遗留的 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`，避免在另一个 Electron 应用的终端里启动失败。

启动后在 iPhone 上：控制中心 → **屏幕镜像** → 选择接收端（默认「免费投屏」）。

窗口顶部工具栏提供启动/停止、重启、重嵌画面、全屏、置顶、隐藏工具栏、设置、日志。点关闭会最小化到托盘，托盘菜单里可彻底退出。

**隐藏工具栏后怎么恢复**：按 `Alt+T`，或右键托盘图标选「显示工具栏」（该菜单项会随状态变成「隐藏工具栏」）。隐藏时会弹出提示，应用启动时若仍处于隐藏状态也会再次提示。这个快捷键在主进程层拦截，工具栏不可见时依然有效。

> 打开「设置」或「日志」面板时，程序会临时隐藏视频窗口，否则 native 子窗口会盖住 HTML 界面；关闭面板后自动恢复。

## dev 分支（基于 v0.0.1）

`dev` 从标签 `v0.0.1` 拉出，用于后续开发。相对 v0.0.1 的三项改动：

1. **画面就在当前窗口里显示**。默认模式由 `owned`（覆盖模式，视频窗口仍是独立顶层窗口，用户会看到「又开了一个新窗口」）改为 `child`：视频 HWND 通过 `SetParent` 真正变成 Electron 主窗口的子窗口。旧的 `owned` / `detached` 仅保留作排查对照。已存在的 v0.0.1 配置会在加载时自动迁移（`owned → child`），不需要手动改设置。
2. **投屏时切换舞台背景色**。设置里新增「投屏时画面背景色」（默认纯黑 `#000000`）；进入投屏状态后舞台切成该颜色，画面按原始宽高比居中并四周留边，露出的背景形成取景框，用来突出共享内容（顺带修正了把竖屏画面拉伸填满横屏窗口的问题）。
3. **守住「第一次投屏就要有画面」**。见下方第四轮：窗口一出现立即嵌入、首帧保护、连续校验自动修复，并配了 22 项自动化回归测试。

## 两种引擎

在「设置 → AirPlay 引擎」里切换：

| 引擎 | 默认 | 可执行文件 | 参数方式 | 适用 |
| --- | --- | --- | --- | --- |
| **Qt 便携版**（uxplay-windows 2.0.0.1736） | ✓ | `runtime/qt/uxplay-windows.exe` | `%APPDATA%\leapbtw\uxplay-windows\arguments.txt` | 所有 x64 CPU，含老 Xeon |
| 命令行版（UxPlay 1.72 CLI） | | `runtime/bin/uxplay.exe` | 命令行 argv | 支持 AVX2 / BMI 的新 CPU |

- Qt 版是基于 `libuxplay` 的托盘程序：启动即运行服务、无可见主窗口、自带音频输出（WASAPI2）、终端不输出日志。
- 命令行版日志更详细，但公开预编译二进制用 `-march=native` 编译，**在不支持 AVX2 的 CPU 上会以 `0xC000001D` 崩溃**。
- 设置里的「uxplay.exe 路径」可指向任意引擎可执行文件，会覆盖引擎选择。

## 运行时（runtime/）

均**不纳入 git**（见 `.gitignore`），用 `scripts/prepare-runtime.ps1` 复现：

```
runtime/qt/                    默认引擎，约 255 MB
  uxplay-windows.exe           uxplay-windows 2.0.0.1736 (GPLv3)
  *.dll                        Qt6 / MSYS2 / GStreamer 依赖
  lib/gstreamer-1.0/           14 个插件（d3d11、d3d12、wasapi2、libav …）
  mDNSResponder.exe / dnssd.dll
runtime/bin/ + runtime/lib/     可选命令行引擎，约 209 MB（231 个插件）
runtime/lib/disabled/           libgstcurl.dll（旧引擎缺依赖，已停用）
```

各组件许可证见 [NOTICE.md](NOTICE.md)。

## 排查记录：为什么默认引擎换成 Qt 版

最初用的是命令行版 `uxplay.exe`，在这台机器上启动后立刻退出，`0xC000001D`。用调试模式抓到异常现场：

```
异常地址 0x7ff612c667c3，机器码 c4 e2 69 f7 d0（shlx，BMI2）
崩溃模块：runtime/bin/uxplay.exe，偏移 +0x167c3
```

线性反汇编统计出 **455 条 AVX2 / BMI 指令**（`vmovdqu ymm`、`vpermd`、`vpbroadcastq` 等）。本机 CPU 是 **Intel Xeon E5-2689**（Sandy Bridge-E，只有 AVX / AES / SSE4.2，无 AVX2 / BMI）。公开的两个预编译来源（`uxplay-windows` 1.72.1-3 安装包、`saimanish1/UxPlay` 1.72.2 便携版）都是同一类 `-march=native` 构建，扫描结果同样是 456 条不支持指令，二进制补丁不可行。

换用 `uxplay-windows` 2.0.0.1736 便携版（Qt + libuxplay）后实测：

- 进程稳定存活，监听 AirPlay 端口 7000 / 7001；
- 手写 mDNS 查询收到完整的 `_airplay._tcp` / `_raop._tcp` 应答（TXT 含 `deviceid`、`model=AppleTV3,2`、`features=0x527FFEE6`、`srcvers=220.68`）；
- `node scripts/smoke-test.js` 稳定输出「引擎持续运行：是 / 已检测到 _airplay._tcp 应答」。

参数兼容性也逐项测过：`-n / -nh / -p / -s / -vs / -nc` 都可用；**`-as wasapisink` 会让 Qt 引擎崩溃**（该包只有 `libgstwasapi2.dll`），所以应用对 Qt 引擎不指定 `-as`，由引擎用自带音频输出。

## 首次连接黑屏（持续排查）

现象：第一次「屏幕镜像」时日志出现 `Begin streaming to GStreamer video pipeline`，但应用窗口没有画面；停止镜像再连一次就正常。上游 `uxplay-windows` 2.0 的已知问题里也写着「首次连接画面冻结，重连一次就好」，说明部分原因在引擎侧。

**真正的根因（第三轮，靠落盘日志 + 窗口枚举实证）**：日志落盘后发现整份日志里**一次「候选窗口」都没出现**——窗口枚举从来没找到视频窗口。枚举真实窗口结构得到：

```
hwnd=4916958 pid=9296 visible=false 516x1100 class=GstD3D12Hwnd title="AirPlay Video Stream"
```

Qt 引擎的视频窗口是顶层窗口，但创建后 **`visible=false`**（等首帧才显示），而旧 `windowsOfPid()` 里有 `IsWindowVisible` 硬过滤。因此前两轮调的 `SetParent` / owner / 延迟嵌入逻辑**一次都没执行到**；第二次连接时看到的画面其实是 Qt 引擎自己弹出的独立窗口，并不是应用嵌入的结果。

**v0.0.1 的修复**：枚举不再因「隐藏」跳过窗口；改为按类名/标题评分识别视频窗口（`GstD3D*`、`AirPlay Video Stream` 优先于 Qt 托盘/主题观察者窗口，隐藏窗口仍参与）；三种模式都主动 `ShowWindow(SW_SHOW)`。日志会记录每个候选窗口的 hwnd / 类名 / 尺寸 / visible / 标题。

### 第四轮（dev 分支）：当前窗口内显示 + 首次投屏保护

v0.0.1 默认的 `owned` 模式不换父窗口，视频窗口仍是顶层窗口浮在应用上方——这正是用户看到的「又弹了一个新窗口」，而且第一次投屏仍可能没画面。dev 分支改成一整套保证首次出画的流程：

- **立即嵌入**：删掉 1500ms 稳定期，隐藏的视频窗口一出现就在同一轮 `SetParent` 成主窗口子窗口，不给它变成独立窗口的机会。嵌入时保持隐藏，先让引擎在首帧自行显示。
- **首帧保护**：默认留 600ms 给引擎；到点窗口仍隐藏，就主动 `ShowWindow(SW_SHOW)` + `SWP_FRAMECHANGED` + `InvalidateRect` 触发重绘。**不再需要断开重连第二次**。
- **连续校验**：每 200ms 检查父子关系、可见性、几何尺寸；引擎若重建父子关系、把窗口藏起来或挪回原始尺寸，就地修复；横竖屏切换还会更新取景框比例。
- **引擎换 PID 自动续盯**：`UxPlayEngine` 新增 `started` 事件，手动重启与崩溃自动重启都会重新挂窗口监视器。
- **回归测试**：`npm run test:firstcast` 共 22 项，覆盖隐藏窗口枚举（第三轮根因）、第一次出现即嵌入、首帧保护、断开重连、父子关系修复、居中留边几何，以及真实 Win32 窗口上的 `SetParent` / 显示 / detach 集成校验。

日志里会看到 `[画面] 已嵌入当前窗口（…）` 与 `[画面] 首帧保护：…`。真机复测时若仍黑屏，把 `%APPDATA%\免费投屏\engine.log` 发出来即可定位。

以下是前两轮的推断，保留作排查记录：

**第一轮修复**（窗口稳定期 + 先 `SetParent` 再改样式 + `SWP_FRAMECHANGED` + 管线日志校正 + 手动重嵌）实测**仍未解决**。由此判断更可能的原因是：`SetParent` 把窗口从顶层 `WS_POPUP` 变成 `WS_CHILD` 这件事本身会让 D3D11 的 swapchain 失效，而第一次连接的 pipeline 不会重建它；第二次连接 pipeline 重建、用已稳定的窗口重新创建 swapchain，才有画面。

**第二轮改成不换父窗口**，并把三种模式做成可切换：

| 模式 | 做法 | 用途 |
| --- | --- | --- |
| `owned`（默认） | `SetWindowLongPtr(GWLP_HWNDPARENT, Electron HWND)` 建立 owner 关系 + `SetWindowPos` 按屏幕坐标定位 | 窗口仍是顶层，D3D11 不受影响；靠 owner 关系浮在应用上方并随之最小化 |
| `child` | 原 `SetParent` 嵌入 | 对照 / 已验证可用的场景 |
| `detached` | 完全不干预，视频窗口独立显示 | 排查用：若独立窗口第一次就有画面，问题确定在嵌入侧 |

设置里切换后立即重新处理窗口，无需重启引擎。

日志已落盘到 `%APPDATA%\免费投屏\engine.log`，会记录**所有候选窗口**（hwnd / 类名 / 尺寸）、选中哪一个、等待多久、用了什么模式、每次校正时间；日志面板有「打开日志文件」按钮。再出问题时把这个文件发出来即可精确定位。

## 已验证 / 待验证

已验证（dev 分支）：环境自检 12 项全过、`npm run test:firstcast` 22 项全过、冒烟测试（引擎存活 + 服务注册）、全量 JS 语法检查、渲染层元素 id 与 CSS 规则一致性、Electron 应用启动无 JS 异常（主进程日志确认 `嵌入模式 = child（当前窗口内显示）`、引擎就绪、无残留进程）。

**仍需你在 iPhone 上验证**：第一次屏幕镜像是否直接在当前窗口出画面（以及不需要第二次）、背景色与居中留边的观感、声音、全屏/置顶时的位置尺寸同步。首次投屏的显示链路由自动化回归测试覆盖，但真实 D3D12 渲染必须有设备才能最终确认。

## 其他已知限制

- Qt 引擎是 GUI 程序，终端没有输出；日志面板主要显示应用自身的启动/配置/守护事件。
- **不要同时开多个实例**：Qt 引擎有单实例锁，多个应用实例会互相抢占，导致引擎反复退出。`node scripts/smoke-test.js` 会结束正在运行的同名引擎，跑测试前最好先退出应用。
- **服务发现依赖 Bonjour Service**。虚拟机 / 多网卡环境下若 iPhone 搜不到，可重启 `Bonjour Service`、确认网络为「专用」、检查防火墙（上游 FAQ 也是这么建议的）。
- `libgstcurl.dll`（旧命令行引擎）依赖分发包里没有的 `libngtcp2-16.dll` 与 `libngtcp2_crypto_ossl.dll`，会让 GStreamer 打印 `Failed to load plugin … Please check that PATH is correct`。已移到 `runtime/lib/disabled/`，与 D3D11 / WASAPI / H.264 解码无关。
- **DRM 内容**（Apple TV+、Netflix 等）无法镜像；部分 iOS 游戏不传音频；不支持 AirPlay 2 多房间音频。
- iOS 大版本升级可能改变协议行为，需跟随上游升级。
- AirPlay 本身有数百毫秒延迟，不适合竞技类游戏；高分屏画面偏移可在设置里调「工具栏高度」或「DPI 缩放覆盖」。
- 未做代码签名，首次运行可能出现 SmartScreen / 杀软提示。

## 目录结构

```
src/main/index.js       主进程：窗口、托盘、IPC、状态广播、视频区域计算
src/main/uxplay.js      引擎管理、两种引擎的参数拼装、日志解析、崩溃重启
src/main/winembed.js    koffi 调 user32.dll：按 PID 找窗口、SetParent、连续校验、尺寸同步
src/main/embedguard.js  首次投屏保护与连续校验（可注入替身做回归测试）
src/main/geometry.js    按宽高比居中留边的纯几何计算
src/main/config.js      配置读写与 v0.0.1 → dev 配置迁移
src/preload/index.js    contextBridge 白名单 API
src/renderer/           中文界面（HTML / CSS / JS）
scripts/start.js        启动入口（清理宿主环境变量）
scripts/check-env.js    环境自检
scripts/test-firstcast.js  首次投屏回归测试（22 项，无需 iPhone）
scripts/smoke-test.js   引擎冒烟测试（含 mDNS 探测）
scripts/prepare-runtime.ps1  下载并解压运行时
scripts/gen_assets.py   用标准库生成托盘图标
assets/                 图标
LICENSE / NOTICE.md     GPLv3 全文与第三方声明
runtime/                外部运行时（不进 git）
```

## 配置项

设置保存在 `%APPDATA%\免费投屏\settings.json`：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| AirPlay 引擎 | Qt 便携版 | 可切到需要 AVX2 的命令行版 |
| 引擎路径 | 空（自动探测） | 覆盖引擎选择 |
| 接收端名称 | 免费投屏 | iPhone 列表里显示的名字 |
| 起始端口 | 7000 | 占用该端口及随后两个 TCP/UDP 端口 |
| 请求分辨率 | 1920x1080 | 720p 延迟更低 |
| 视频输出 | d3d11videosink | Qt 引擎可用 d3d12videosink |
| 音频输出 | wasapisink | 仅命令行引擎生效 |
| 断开后保留窗口 | 开（`-nc`） | 避免每次重连重新嵌入 |
| 画面显示方式 | child（当前窗口内） | 可选 owned（独立顶层窗口）/ detached（完全不干预），两者仅供排查 |
| 首次投屏显示保护 | 600 ms | 留给引擎自行显示首帧；到点仍隐藏则主动显示并重绘 |
| 投屏时画面背景色 | #000000 | 画面按原比例居中，四周留边露出该背景色 |
| 工具栏高度 / DPI 缩放 | 56 / 自动 | 画面错位时微调 |
| 额外参数 | 空 | 追加给引擎（Qt 引擎写入 arguments.txt） |
| 运行日志 | `%APPDATA%\免费投屏\engine.log` | 日志面板「打开日志文件」可直接打开 |

修改后点「保存并重启」生效。

## 许可证

本项目采用 **GNU GPL v3 或更高版本**，见 [LICENSE](LICENSE)。由于内置/调用 GPLv3 的 UxPlay 与 uxplay-windows，任何对外分发都需遵守 GPLv3 的源码提供与署名义务，清单见 [NOTICE.md](NOTICE.md)。

仅在自己电脑上运行、不对外分发时，GPLv3 的源码提供义务不触发。

本项目与 Apple Inc. 无关联；AirPlay 是 Apple Inc. 的注册商标。UxPlay 上游对其 FairPlay 相关第三方库的法律状态有免责声明，公开发布前请自行评估。
