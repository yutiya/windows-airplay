'use strict';

// 首次投屏回归测试（dev 分支）
//
// 复现并守住三个历史问题：
//   1. v0.0.1 之前隐藏的视频窗口被 IsWindowVisible 过滤掉，嵌入逻辑一次都没跑；
//   2. 旧版有 1500ms 稳定期，窗口要等到第二轮甚至第二次连接才被处理；
//   3. 引擎不主动显示窗口时，第一次投屏黑屏，必须断开重连才出画面。
//
// 不需要真 iPhone：用假窗口跑 watch 状态机 + embedguard，再用真实 Win32
// 窗口跑一次 FFI 集成校验。运行：node scripts/test-firstcast.js

const assert = require('node:assert/strict');
const koffi = require('koffi');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const geometry = require(path.join(ROOT, 'src', 'main', 'geometry'));
const guard = require(path.join(ROOT, 'src', 'main', 'embedguard'));
const winembed = require(path.join(ROOT, 'src', 'main', 'winembed'));
const config = require(path.join(ROOT, 'src', 'main', 'config'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log('  PASS  ' + name);
  }).catch((err) => {
    failed += 1;
    console.log('  FAIL  ' + name + '\n        ' + (err && err.message || err));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 纯几何

function geometryTests() {
  const stage = { x: 0, y: 56, width: 1180, height: 704 };

  return Promise.all([
    test('竖屏画面在横屏舞台里保持宽高比、居中且四周留边', () => {
      const r = geometry.fitRect(stage, 516 / 1100, 10);
      assert.ok(Math.abs(r.width / r.height - 516 / 1100) < 0.01, '宽高比被破坏');
      assert.ok(r.width < stage.width - 20, '左右应留出背景色');
      assert.ok(r.height <= stage.height - 20, '上下应留出背景色');
      assert.ok(Math.abs((r.x + r.width / 2) - (stage.x + stage.width / 2)) <= 1, '水平未居中');
      assert.ok(Math.abs((r.y + r.height / 2) - (stage.y + stage.height / 2)) <= 1, '垂直未居中');
      assert.ok(r.x > stage.x && r.y >= stage.y, '不应越出舞台');
    }),
    test('横屏画面按 16:9 居中，不越界', () => {
      const r = geometry.fitRect(stage, 16 / 9, 10);
      assert.ok(Math.abs(r.width / r.height - 16 / 9) < 0.01);
      assert.ok(r.width <= stage.width - 20 && r.height <= stage.height - 20);
      assert.ok(r.x >= stage.x && r.y >= stage.y);
    }),
    test('宽高比未知时填满容器但仍保留 padding', () => {
      const r = geometry.fitRect(stage, 0, 10);
      assert.equal(r.width, stage.width - 20);
      assert.equal(r.height, stage.height - 20);
      assert.equal(r.x, 10);
      assert.equal(r.y, 66);
    }),
    test('极小舞台不会算出负数或零尺寸', () => {
      const r = geometry.fitRect({ x: 0, y: 0, width: 8, height: 6 }, 0.5, 10);
      assert.ok(r.width >= 1 && r.height >= 1);
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
    })
  ]);
}

// ------------------------------------------------------- 配置迁移

function configTests() {
  return Promise.all([
    test('v0.0.1 旧配置自动迁移：owned → child、1500ms → 600ms', () => {
      const c = config.migrate({ embedMode: 'owned', embedDelayMs: 1500, serverName: '免费投屏' });
      assert.equal(c.embedMode, 'child', '默认必须在当前窗口内显示');
      assert.equal(c.embedDelayMs, 600);
      assert.equal(c.streamBgColor, '#000000', '投屏背景色应有默认值');
      assert.equal(c.configVersion, 2);
      assert.equal(c.serverName, '免费投屏', '其它用户设置应保留');
    }),
    test('显式选择过的排查模式不会被迁移覆盖', () => {
      const c = config.migrate({ embedMode: 'detached', embedDelayMs: 2500, configVersion: 1 });
      assert.equal(c.embedMode, 'detached');
      assert.equal(c.embedDelayMs, 2500);
    })
  ]);
}

// --------------------------------------------- 首帧保护 / 连续校验

function makeFakeWindow() {
  const state = {
    visible: false,
    parent: 4242,
    rect: { x: 0, y: 0, width: 516, height: 1100 }
  };
  const api = {
    getParent: () => state.parent,
    isVisible: () => state.visible,
    embed: (_hwnd, parent) => { state.parent = parent; },
    show: (_hwnd, v) => { state.visible = Boolean(v); },
    nudge: () => {},
    windowRect: () => ({ ...state.rect }),
    keepPosition: (_hwnd, r) => { state.rect = { x: r.x, y: r.y, width: r.width, height: r.height }; }
  };
  return { state, api };
}

function guardCtx(fake, overrides = {}) {
  const hwnd = 9090;
  const rect = { x: 30, y: 56, width: 320, height: 682 };
  return {
    hwnd,
    embedded: { hwnd, mode: 'child', showAfter: 1000 },
    streaming: true,
    panelOpen: false,
    quitting: false,
    parentHwnd: 4242,
    currentRect: () => rect,
    aspect: 516 / 1100,
    winembed: fake.api,
    log: () => {},
    onAspectChanged: () => {},
    now: 999,
    ...overrides
  };
}

function guardTests() {
  const fake = makeFakeWindow();
  return Promise.all([
    test('首帧保护期内不抢着显示，交给引擎自己出首帧', () => {
      const r = guard.verifyEmbedded(guardCtx(fake, { now: 999 }));
      assert.equal(r.skipped, false);
      assert.equal(r.shown, false);
      assert.equal(fake.state.visible, false);
    }),
    test('到点引擎仍未显示 → 主动显示并请求重绘（第一次投屏就有画面）', () => {
      const r = guard.verifyEmbedded(guardCtx(fake, { now: 1000 }));
      assert.equal(r.shown, true, '必须主动显示，否则又要等第二次投屏');
      assert.equal(fake.state.visible, true);
    }),
    test('已经显示时不再重复打扰渲染', () => {
      const r = guard.verifyEmbedded(guardCtx(fake, { now: 3000 }));
      assert.equal(r.shown, false);
      assert.equal(r.error, false);
    }),
    test('父子关系丢失时自动重新嵌入当前窗口', () => {
      fake.state.parent = 0;
      const r = guard.verifyEmbedded(guardCtx(fake, { now: 3000 }));
      assert.equal(r.repairedParent, true);
      assert.equal(fake.state.parent, 4242);
    }),
    test('打开设置/日志面板或未在投屏时跳过校验', () => {
      assert.equal(guard.verifyEmbedded(guardCtx(fake, { panelOpen: true })).skipped, true);
      assert.equal(guard.verifyEmbedded(guardCtx(fake, { streaming: false })).skipped, true);
      assert.equal(guard.verifyEmbedded(guardCtx(fake, { quitting: true })).skipped, true);
    }),
    test('独立窗口排查模式下不做任何干预', () => {
      const r = guard.verifyEmbedded(guardCtx(fake, {
        embedded: { hwnd: 9090, mode: 'detached', showAfter: 0 },
        now: 3000
      }));
      assert.equal(r.skipped, true);
      assert.equal(r.shown, false);
    }),
    test('引擎把窗口挪回原始尺寸时，按取景框重新定位', () => {
      // 前面的用例已经校正过一次，这里显式模拟引擎再次改动尺寸
      fake.state.rect = { x: 0, y: 0, width: 516, height: 1100 };
      const r = guard.verifyEmbedded(guardCtx(fake, { now: 3000 }));
      assert.equal(r.repositioned, true);
      assert.equal(fake.state.rect.width, 320);
      assert.equal(fake.state.rect.height, 682);
    })
  ]);
}

// ------------------------------------------------- watch 状态机

async function watchStateMachineTests() {
  let windows = [];
  const alive = new Set();
  const found = [];
  const lost = [];
  let verified = 0;

  const stop = winembed.watch(12345, {
    interval: 15,
    settleMs: 0,
    enumerate: () => windows,
    isAlive: (hwnd) => alive.has(hwnd),
    verify: () => { verified += 1; },
    onCandidate: () => {},
    onFound: (item) => { found.push(item.hwnd); return 0; },
    onLost: () => { lost.push(Date.now()); }
  });

  try {
    // 引擎刚启动，还没有视频窗口
    await sleep(60);
    await test('窗口未出现时不误触发嵌入', () => assert.equal(found.length, 0));

    // 第一次投屏：视频窗口是隐藏的，必须在这一轮就被发现并嵌入
    windows = [{ hwnd: 1001, cls: 'GstD3D12Hwnd', title: 'AirPlay Video Stream', visible: false, width: 516, height: 1100 }];
    alive.add(1001);
    await sleep(60);
    await test('第一次投屏：隐藏窗口一出现立即嵌入，无需等第二次', () => {
      assert.equal(found.length, 1, '应恰好嵌入一次');
      assert.equal(found[0], 1001);
      assert.ok(verified > 0, '嵌入后应持续校验');
    });
    await test('同一窗口稳定存在时不会重复嵌入', async () => {
      await sleep(60);
      assert.equal(found.length, 1);
    });

    // 断开再投：旧窗口销毁、新窗口出现，watcher 必须自动跟上
    alive.delete(1001);
    windows = [];
    await sleep(60);
    await test('断开时能感知窗口消失', () => assert.equal(lost.length, 1));

    windows = [{ hwnd: 1002, cls: 'GstD3D12Hwnd', title: 'AirPlay Video Stream', visible: false, width: 516, height: 1100 }];
    alive.add(1002);
    await sleep(60);
    await test('第二次投屏：新窗口也能自动嵌入，不残留旧状态', () => {
      assert.equal(found.length, 2);
      assert.equal(found[1], 1002);
    });
  } finally {
    stop();
  }
}

// ------------------------------------------- 真实 Win32 FFI 集成

function realWindowTests() {
  const WS_VISIBLE = 0x10000000;
  const WS_POPUP = 0x80000000;
  const WS_OVERLAPPEDWINDOW = 0x00cf0000;
  const user32 = koffi.load('user32.dll');
  const create = user32.func('uintptr_t __stdcall CreateWindowExW(uint32 exStyle, void *cls, void *name, uint32 style, int32 x, int32 y, int32 w, int32 h, uintptr_t parent, uintptr_t menu, uintptr_t instance, uintptr_t param)');
  const destroy = user32.func('bool __stdcall DestroyWindow(uintptr_t hwnd)');
  const wbuf = (text) => Buffer.from(String(text) + '\0', 'utf16le');

  const parent = Number(create(0, wbuf('STATIC'), wbuf('Fake Electron MainWindow'),
    (WS_OVERLAPPEDWINDOW | WS_VISIBLE) >>> 0, 20, 20, 900, 600, 0, 0, 0, 0));
  // 模拟 Qt 引擎第一次连接时创建的隐藏视频窗口（GstD3D12Hwnd 是自定义类，
  // 这里用同名标题触发同一套候选评分逻辑）
  const video = Number(create(0, wbuf('STATIC'), wbuf('AirPlay Video Stream'),
    WS_POPUP >>> 0, 100, 100, 516, 1100, 0, 0, 0, 0));

  if (!parent || !video) {
    return test('真实 Win32 窗口可用于集成校验', () => assert.fail('CreateWindowExW 返回空句柄'));
  }

  const rect = { x: 30, y: 56, width: 320, height: 682 };
  let previous = 0;

  return Promise.resolve()
    .then(() => test('隐藏的视频窗口必须能被枚举到（v0.0.1 黑屏根因）', () => {
      assert.equal(winembed.isVisible(video), false);
      const list = winembed.candidateWindows(process.pid);
      const hit = list.find((item) => item.hwnd === video);
      assert.ok(hit, 'candidateWindows 漏掉了隐藏窗口');
      assert.equal(hit.visible, false);
      assert.equal(hit.title, 'AirPlay Video Stream');
    }))
    .then(() => test('SetParent 真正把画面变成当前窗口的子窗口，且保持隐藏', () => {
      previous = winembed.embed(video, parent, rect, { show: false });
      assert.equal(winembed.getParent(video), parent);
      assert.equal(winembed.isVisible(video), false, '首帧保护期内不应提前显示');
      const r = winembed.windowRect(video);
      assert.ok(Math.abs(r.width - rect.width) <= 2, `宽度不符：${r.width}`);
      assert.ok(Math.abs(r.height - rect.height) <= 2, `高度不符：${r.height}`);
    }))
    .then(() => test('首帧保护在真实窗口上生效：到点主动显示', () => {
      const before = guard.verifyEmbedded({
        hwnd: video,
        embedded: { hwnd: video, mode: 'child', showAfter: Date.now() + 10000 },
        streaming: true, panelOpen: false, quitting: false,
        parentHwnd: parent, currentRect: () => rect, aspect: 516 / 1100,
        winembed, log: () => {}, onAspectChanged: () => {}, now: Date.now()
      });
      assert.equal(before.shown, false);
      assert.equal(winembed.isVisible(video), false);

      const after = guard.verifyEmbedded({
        hwnd: video,
        embedded: { hwnd: video, mode: 'child', showAfter: 0 },
        streaming: true, panelOpen: false, quitting: false,
        parentHwnd: parent, currentRect: () => rect, aspect: 516 / 1100,
        winembed, log: () => {}, onAspectChanged: () => {}, now: Date.now()
      });
      assert.equal(after.shown, true);
      assert.equal(winembed.isVisible(video), true, '第一次投屏应能看到画面');
    }))
    .then(() => test('detach 后恢复原始顶层样式，且不会弹出独立窗口', () => {
      winembed.detach(video, previous);
      assert.equal(winembed.getParent(video), 0);
      assert.equal(winembed.isVisible(video), false, '原本隐藏的窗口不应被显示成新窗口');
    }))
    .finally(() => {
      try { destroy(video); } catch (_) { /* 已销毁 */ }
      try { destroy(parent); } catch (_) { /* 已销毁 */ }
    });
}

(async () => {
  console.log('\n首次投屏回归测试（dev）');
  console.log('────────────────────────────────────────');
  await geometryTests();
  await configTests();
  await guardTests();
  await watchStateMachineTests();
  await realWindowTests();
  console.log('────────────────────────────────────────');
  console.log(`结果：${passed} 项通过，${failed} 项失败\n`);
  process.exitCode = failed ? 1 : 0;
})();
