'use strict';

// 纯几何计算，不依赖 Electron / Win32，便于回归测试直接调用。
// 坐标单位统一为物理像素：子窗口模式用父窗口客户区坐标，覆盖模式用屏幕坐标。

// 把视频源按原始宽高比居中放进容器，四周留出 padding。
// 露出来的这一圈容器背景就是「投屏时的背景色」，用来给共享画面做取景框。
// aspect <= 0 或非法时退化为填满（仍保留 padding）。
function fitRect(container, aspect, padding = 0) {
  const box = {
    x: Math.round(Number(container.x) || 0),
    y: Math.round(Number(container.y) || 0),
    width: Math.max(1, Math.round(Number(container.width) || 0)),
    height: Math.max(1, Math.round(Number(container.height) || 0))
  };
  const pad = Math.max(0, Math.min(
    Math.round(Number(padding) || 0),
    Math.floor(Math.min(box.width, box.height) / 2)
  ));
  const innerW = Math.max(1, box.width - pad * 2);
  const innerH = Math.max(1, box.height - pad * 2);
  const ratio = Number(aspect);

  let width = innerW;
  let height = innerH;
  if (ratio > 0 && Number.isFinite(ratio)) {
    width = Math.max(1, Math.min(innerW, Math.round(innerH * ratio)));
    height = Math.max(1, Math.min(innerH, Math.round(innerW / ratio)));
    // 修正两次独立四舍五入可能造成的轻微越界
    if (width > innerW) { width = innerW; height = Math.max(1, Math.round(width / ratio)); }
    if (height > innerH) { height = innerH; width = Math.max(1, Math.round(height * ratio)); }
  }

  return {
    x: box.x + Math.round((box.width - width) / 2),
    y: box.y + Math.round((box.height - height) / 2),
    width,
    height
  };
}

function aspectOf(rect) {
  if (!rect || !Number(rect.height)) return 0;
  const ratio = Number(rect.width) / Number(rect.height);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
}

module.exports = { fitRect, aspectOf };
