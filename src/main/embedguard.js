'use strict';

const geometry = require('./geometry');

// 「第一次投屏就要有画面」的连续校验逻辑。
// 独立成模块是为了让 scripts/test-firstcast.js 能用假窗口反复跑回归，
// 不必每次都拿真 iPhone 投屏。winembed 由调用方注入（生产用真实 FFI，测试用替身）。
//
// 返回一次校验的动作清单，方便断言：
// { skipped, repairedParent, shown, repositioned, aspectChanged, aspect, error }
function verifyEmbedded(ctx) {
  const {
    quitting = false,
    panelOpen = false,
    streaming = false,
    embedded = null,
    hwnd = 0,
    parentHwnd = 0,
    currentRect = () => null,
    aspect = 0,
    winembed,
    log = () => {},
    onAspectChanged = () => {},
    now = Date.now()
  } = ctx;

  const skipped = Boolean(quitting || panelOpen || !streaming || !embedded || embedded.hwnd !== hwnd);
  const result = {
    skipped,
    repairedParent: false,
    shown: false,
    repositioned: false,
    aspectChanged: false,
    aspect: aspect || 0,
    error: false
  };
  if (skipped) return result;
  // 独立窗口是排查用的对照模式，主进程承诺「完全不干预」，别给它下发坐标
  if (embedded.mode === 'detached') {
    result.skipped = true;
    return result;
  }

  try {
    if (embedded.mode === 'child' && parentHwnd && winembed.getParent(hwnd) !== parentHwnd) {
      winembed.embed(hwnd, parentHwnd, currentRect(), { show: false });
      result.repairedParent = true;
      log('[画面] 父子关系丢失，已重新嵌入当前窗口');
    }

    // 首帧保护：先给引擎自行显示的机会，到点仍隐藏就主动显示并请求重绘。
    // 这是「不用等第二次投屏」的关键一步。
    if (!winembed.isVisible(hwnd) && now >= (embedded.showAfter || 0)) {
      winembed.show(hwnd, true);
      winembed.nudge(hwnd, currentRect());
      result.shown = true;
      log('[画面] 首帧保护：引擎未自行显示视频窗口，已主动显示并请求重绘');
    }

    const actual = winembed.windowRect(hwnd);
    const expected = currentRect();
    if (actual && expected &&
        (Math.abs(actual.width - expected.width) > 4 || Math.abs(actual.height - expected.height) > 4)) {
      const ratio = geometry.aspectOf(actual);
      if (ratio > 0.2 && ratio < 5 && Math.abs(ratio - (aspect || 0)) > 0.08) {
        result.aspectChanged = true;
        result.aspect = ratio;
        onAspectChanged(ratio);
        log(`[画面] 画面方向变化，宽高比更新为 ${ratio.toFixed(3)}`);
      }
      winembed.keepPosition(hwnd, currentRect());
      result.repositioned = true;
    }
  } catch (_) {
    result.error = true; // 窗口可能刚好被销毁，下一轮 onLost 处理
  }
  return result;
}

module.exports = { verifyEmbedded };
