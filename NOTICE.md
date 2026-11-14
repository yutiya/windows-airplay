# 第三方组件与许可证声明

本项目整体采用 **GNU GPL v3 或更高版本**（见根目录 `LICENSE`）。

运行时会调用或随分发包附带以下第三方组件。它们的许可证相互独立，本项目的 GPLv3 不覆盖其原有权利。

| 组件 | 用途 | 许可证 | 上游 |
| --- | --- | --- | --- |
| uxplay-windows 2.0（默认引擎） | 把 UxPlay 封装成 Windows 托盘应用（libuxplay + Qt6），CPU 可移植 | GPLv3 | https://github.com/leapbtw/uxplay-windows |
| UxPlay | AirPlay 2 协议接收端（服务发现、配对、FairPlay 解密、RTP 收流） | GPL-3.0-or-later（部分 LGPL-2.1+ / MIT） | https://github.com/FDH2/UxPlay |
| Qt 6 | 默认引擎的 GUI / 托盘框架 | LGPL-3.0 / GPL（动态链接） | https://www.qt.io |
| GStreamer 及插件 | H.264 解码、D3D11 视频渲染、WASAPI 音频输出 | LGPL-2.1（动态链接） | https://gstreamer.freedesktop.org |
| mDNSResponder | Windows 上的 DNS-SD / Bonjour 服务发现 | Apache-2.0 / BSD-3-Clause | https://github.com/apple-oss-distributions/mDNSResponder |
| PlayFair / ShairPlay / RPiPlay 派生代码 | UxPlay 内部使用的 FairPlay 与 AirPlay 实现 | GPL / LGPL-2.1+ | 见 UxPlay 仓库 README 的作者说明 |
| Electron / Chromium / Node.js | 桌面应用运行时 | MIT / BSD 等 | https://www.electronjs.org |
| koffi | 主进程调用 Win32 API 的 FFI 绑定 | MIT | https://github.com/Koromix/koffi |

## 分发时的合规清单

若你要把本应用连同 UxPlay 二进制一起分发给别人，需要：

1. 随包提供本仓库完整对应源码，或给出可获取完整对应源码的书面方式。
2. 随包附上 `LICENSE`（GPLv3 全文）与版权声明。
3. 保留 UxPlay、PlayFair、ShairPlay、RPiPlay、GStreamer、mDNSResponder 各自的版权与许可证文本。
4. GStreamer 以动态链接的 DLL 形式分发，保证使用者可以替换这些库。
5. 明确标注对本仓库或 UxPlay 所做的任何修改。

仅在自己电脑上运行、不对外分发时，GPLv3 的源码提供义务不触发。

## 其他说明

- UxPlay 上游对其 FairPlay 相关第三方库的法律状态有明确免责声明；公开发布前请自行评估。
- 本项目与 Apple Inc. 无关联。AirPlay 是 Apple Inc. 的注册商标。
- DRM 保护的内容（如 Apple TV+、Netflix）无法通过本应用镜像，这是 Apple 端的限制。
