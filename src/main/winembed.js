'use strict';

// 通过 FFI 调用 user32.dll，把 GStreamer 创建的视频窗口嵌入 Electron 窗口。
// 这里刻意不链接 UxPlay、不读它的内部数据，只做操作系统层面的窗口管理。

const koffi = require('koffi');

const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_CLIPCHILDREN = 0x02000000;
const GWL_STYLE = -16;
const GWLP_HWNDPARENT = -8;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

let api = null;
let callbackProto = null;

function win32() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  callbackProto = koffi.proto('bool __stdcall EnumWindowsProc(uintptr_t hwnd, uintptr_t lparam)');
  api = {
    EnumWindows: user32.func('bool __stdcall EnumWindows(void *cb, uintptr_t lparam)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void *pid)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)'),
    IsWindow: user32.func('bool __stdcall IsWindow(uintptr_t hwnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, void *rect)'),
    GetClassNameW: user32.func('int32 __stdcall GetClassNameW(uintptr_t hwnd, void *buf, int32 max)'),
    GetWindowTextW: user32.func('int32 __stdcall GetWindowTextW(uintptr_t hwnd, void *buf, int32 max)'),
    GetWindowLongPtrW: user32.func('int64 __stdcall GetWindowLongPtrW(uintptr_t hwnd, int32 index)'),
    SetWindowLongPtrW: user32.func('int64 __stdcall SetWindowLongPtrW(uintptr_t hwnd, int32 index, int64 value)'),
    SetParent: user32.func('uintptr_t __stdcall SetParent(uintptr_t child, uintptr_t parent)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(uintptr_t hwnd, uintptr_t after, int32 x, int32 y, int32 w, int32 h, uint32 flags)'),
    MoveWindow: user32.func('bool __stdcall MoveWindow(uintptr_t hwnd, int32 x, int32 y, int32 w, int32 h, bool repaint)'),
    InvalidateRect: user32.func('bool __stdcall InvalidateRect(uintptr_t hwnd, void *rect, bool erase)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hwnd, int32 cmd)')
  };
  return api;
}

function className(hwnd) {
  const w = win32();
  const buf = Buffer.alloc(256 * 2);
  w.GetClassNameW(hwnd, buf, 256);
  return buf.toString('utf16le').replace(/\0.*$/, '');
}

function windowTitle(hwnd) {
  const w = win32();
  const buf = Buffer.alloc(256 * 2);
  w.GetWindowTextW(hwnd, buf, 256);
  return buf.toString('utf16le').replace(/\0.*$/, '');
}

// 枚举属于指定进程的顶层窗口。
// 不能按 IsWindowVisible 过滤：Qt 引擎的 D3D12 视频窗口
// （GstD3D12Hwnd / "AirPlay Video Stream"）创建后是隐藏的，等首帧才显示，
// 过滤掉就永远找不到，嵌入逻辑一次都不会执行。
function windowsOfPid(pid) {
  const w = win32();
  const out = [];
  const cb = koffi.register((rawHwnd) => {
    const hwnd = Number(rawHwnd);
    if (!hwnd) return true;
    const pidBuf = Buffer.alloc(4);
    w.GetWindowThreadProcessId(hwnd, pidBuf);
    if (pidBuf.readUInt32LE(0) !== pid) return true;

    const rect = Buffer.alloc(16);
    w.GetWindowRect(hwnd, rect);
    out.push({
      hwnd,
      cls: className(hwnd),
      title: windowTitle(hwnd),
      visible: Boolean(w.IsWindowVisible(hwnd)),
      x: rect.readInt32LE(0),
      y: rect.readInt32LE(4),
      width: rect.readInt32LE(8) - rect.readInt32LE(0),
      height: rect.readInt32LE(12) - rect.readInt32LE(4)
    });
    return true;
  }, koffi.pointer(callbackProto));

  try {
    w.EnumWindows(cb, 0);
  } finally {
    if (typeof koffi.unregister === 'function') koffi.unregister(cb);
  }
  return out;
}

// 按「是不是视频窗口」评分，而不是单纯按面积：Qt 的托盘/主题观察者窗口
// 面积可能更大，而真正的视频窗口此时还是隐藏的。
function candidateWindows(pid) {
  const list = windowsOfPid(pid)
    .filter((item) => item.width >= 120 && item.height >= 100)
    .filter((item) => !/console|cascadia|windows\.terminal|^IME$/i.test(item.cls))
    // Qt 托盘 / 主题观察者 / 消息窗口不是视频窗口，绝不能嵌入
    .filter((item) => !/qt\d+.*(tray|observer|message|icon)|qwindowicon/i.test(item.cls))
    .map((item) => {
      const tag = (item.cls + ' ' + item.title).toLowerCase();
      let score = item.width * item.height;
      if (/gstd3d|gstreamer|airplay video|video stream|d3d1[12]/i.test(tag)) score += 100000000;
      if (item.visible) score += 50000000;
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score);

  // 隐藏的 D3D 视频窗口也要认；若这类窗口不存在，则只接受当前可见的窗口
  // （兼容命令行引擎），避免把 Qt 辅助窗口当成画面嵌进去。
  const video = list.filter((item) =>
    /gstd3d|gstreamer|airplay video|video stream|d3d1[12]/i.test(item.cls + ' ' + item.title));
  if (video.length) return video;
  return list.filter((item) => item.visible);
}

function pickVideoWindow(pid) {
  return candidateWindows(pid)[0] || null;
}

// SetWindowPos 带 SWP_FRAMECHANGED 才能让 WS_CHILD 变更真正生效并触发 WM_SIZE，
// D3D11 videosink 依赖这一步重建 swapchain。
function place(hwnd, rect, frameChanged) {
  const w = win32();
  if (!w.IsWindow(hwnd)) return false;
  const x = Math.round(rect.x || 0);
  const y = Math.round(rect.y || 0);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | (frameChanged ? SWP_FRAMECHANGED : 0);
  return Boolean(w.SetWindowPos(hwnd, 0, x, y, width, height, flags >>> 0));
}

function embed(childHwnd, parentHwnd, rect) {
  const w = win32();
  const originalStyle = Number(w.GetWindowLongPtrW(childHwnd, GWL_STYLE)) >>> 0;
  // 顺序很重要：先 SetParent，再改样式。窗口还是顶层时把 WS_POPUP 改成 WS_CHILD
  // 会触发窗口重建，打断首次 D3D11 渲染初始化（表现为第一次连接黑屏）。
  w.SetParent(childHwnd, parentHwnd);
  const style = (originalStyle | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN)
    & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU & ~WS_MINIMIZEBOX & ~WS_MAXIMIZEBOX;
  w.SetWindowLongPtrW(childHwnd, GWL_STYLE, style >>> 0);
  w.ShowWindow(childHwnd, SW_SHOW);
  place(childHwnd, rect, true);
  return originalStyle;
}

function detach(childHwnd, originalStyle) {
  const w = win32();
  if (!w.IsWindow(childHwnd)) return;
  w.SetParent(childHwnd, 0);
  if (originalStyle !== undefined && originalStyle !== null) {
    w.SetWindowLongPtrW(childHwnd, GWL_STYLE, originalStyle >>> 0);
  }
  w.ShowWindow(childHwnd, SW_SHOW);
}

function move(hwnd, rect) {
  return place(hwnd, rect, false);
}

// 温和校正：不换父窗口，只重新下发几何 + 让客户区重绘，
// 用于 GStreamer 管线开始推流后唤醒已经嵌入但没出画面的窗口。
function nudge(hwnd, rect) {
  const w = win32();
  if (!w.IsWindow(hwnd)) return false;
  place(hwnd, rect, true);
  try { w.InvalidateRect(hwnd, null, true); } catch (_) { /* 某些窗口不接受 */ }
  return true;
}

// 覆盖模式：不 SetParent、不改 WS_CHILD，视频窗口仍是顶层 WS_POPUP，
// D3D11 swapchain 不会因父子关系变化而失效。
// GWLP_HWNDPARENT 只是建立 owner 关系：窗口始终在 Electron 上方、随之最小化。
function attachAsOwned(hwnd, ownerHwnd, screenRect) {
  const w = win32();
  if (!w.IsWindow(hwnd)) return 0;
  const previousOwner = Number(w.GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT)) >>> 0;
  w.SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, ownerHwnd);
  w.ShowWindow(hwnd, SW_SHOW);
  repositionOwned(hwnd, screenRect);
  return previousOwner;
}

function repositionOwned(hwnd, screenRect) {
  const w = win32();
  if (!w.IsWindow(hwnd) || !screenRect) return false;
  const x = Math.round(screenRect.x || 0);
  const y = Math.round(screenRect.y || 0);
  const width = Math.max(1, Math.round(screenRect.width));
  const height = Math.max(1, Math.round(screenRect.height));
  const flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW;
  return Boolean(w.SetWindowPos(hwnd, 0, x, y, width, height, flags >>> 0));
}

function detachOwned(hwnd, previousOwner) {
  const w = win32();
  if (!w.IsWindow(hwnd)) return;
  w.SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, previousOwner || 0);
}

function exists(hwnd) {
  return Boolean(hwnd) && Boolean(win32().IsWindow(hwnd));
}

// 打开设置/日志面板时临时隐藏视频窗口，否则 native 子窗口会盖住 HTML 界面
function show(hwnd, visible) {
  const w = win32();
  if (!w.IsWindow(hwnd)) return false;
  return Boolean(w.ShowWindow(hwnd, visible ? SW_SHOW : SW_HIDE));
}

// 轮询等待视频窗口出现，并在「窗口稳定」后才嵌入。
// settleMs：窗口首次出现且尺寸不再变化后需要等待的时间。
// shouldEmbed：外部信号（例如 "Begin streaming to GStreamer video pipeline"）可提前放行。
function watch(pid, {
  interval = 400,
  settleMs = 1500,
  maxWaitMs = 8000,
  shouldEmbed = null,
  onCandidate = null,
  release = detach,
  onFound,
  onLost
} = {}) {
  let candidate = null;
  let current = null;
  let originalStyle = null;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    if (current) {
      if (!exists(current.hwnd)) {
        const lost = current;
        current = null;
        originalStyle = null;
        if (onLost) onLost(lost);
      }
      return;
    }

    let found = null;
    let all = [];
    try {
      all = candidateWindows(pid);
      found = all[0] || null;
    } catch (_) {
      return; // 枚举失败不应打断主流程，下一轮再试
    }
    if (!found) {
      candidate = null;
      return;
    }

    const changed = !candidate
      || candidate.hwnd !== found.hwnd
      || Math.abs(candidate.width - found.width) > 8
      || Math.abs(candidate.height - found.height) > 8;
    if (changed) {
      candidate = { hwnd: found.hwnd, since: Date.now(), width: found.width, height: found.height };
      if (onCandidate) onCandidate(found, 0);
      return;
    }

    const waited = Date.now() - candidate.since;
    const forced = typeof shouldEmbed === 'function' && shouldEmbed();
    if (waited < settleMs && !forced && waited < maxWaitMs) {
      if (onCandidate) onCandidate(found, waited, all);
      return;
    }
    if (!onFound) return;

    const style = onFound(found, waited, forced);
    if (style === null || style === undefined) {
      candidate = null; // 嵌入失败，下一轮重新计时再试
      return;
    }
    current = found;
    originalStyle = style;
  }, interval);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (current && originalStyle !== null) {
      try { release(current.hwnd, originalStyle); } catch (_) { /* 窗口已销毁 */ }
    }
  };
}

module.exports = {
  windowsOfPid, candidateWindows, pickVideoWindow, embed, detach, move, nudge, show, exists, watch,
  attachAsOwned, repositionOwned, detachOwned
};
