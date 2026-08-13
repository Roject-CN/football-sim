#!/usr/bin/env node
/**
 * 强制场景测试:角旗区被困(复刻用户遥测:红1 @(131,437) 与红2 互传死循环)
 * 验证:回传惩罚 + 全队卡顿逃生阀能否在数秒内打破互传循环(解围/冒险前传),而非无限倒脚
 *
 * 用法: node tools/forcebox.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, '涌现式足球demo-3v3.html');

function makeCtx() { return new Proxy({}, { get: (t, k) => (...a) => {}, set: () => true }); }
function makeEl() {
  return {
    textContent: '', innerHTML: '', style: {}, checked: false, value: '3', dataset: {},
    classList: { add() {}, remove() {} },
    children: [], lastChild: { remove() {} },
    prepend() {}, appendChild() {}, addEventListener() {},
    querySelectorAll: () => [], querySelector: () => null, getContext: () => makeCtx()
  };
}

const html = fs.readFileSync(DEMO, 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n/g, '\n');
const elements = {};
global.document = {
  getElementById: (id) => elements[id] || (elements[id] = makeEl()),
  createElement: () => makeEl(), body: makeEl(),
  querySelectorAll: () => [], querySelector: () => null
};
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => {};
global.Blob = class {}; global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };

const tail = `
global.__passEvts = [];
const __origLog = log;
log = function (msg, cls) {
  __origLog(msg, cls);
  let m = /^(红|蓝)(\\d) (传球|高空球) → (红|蓝)(\\d)$/.exec(msg);
  if (m) global.__passEvts.push({ t: simT, from: m[1] + m[2], to: m[4] + m[5] });
  else {
    m = /^(红|蓝)(\\d) (解围!)$/.exec(msg);
    if (m) global.__passEvts.push({ t: simT, from: m[1] + m[2], to: 'CLEAR' });
  }
};
global.__g = { kickoff, step, playersA: () => playersA, playersB: () => playersB,
  simT: () => simT, ball: () => ball, nameOf };
`;
new Function(code + tail)();
const g = global.__g;
elements.ckGK_A = makeEl(); elements.ckGK_A.checked = true;
elements.ckGK_B = makeEl(); elements.ckGK_B.checked = true;
g.kickoff();

// —— 布置用户遥测场景:红队右侧进攻,红1 被压在左底线角旗区 ——
const red = g.playersA().filter(p => !p.isGK);
const blue = g.playersB().filter(p => !p.isGK);
const [r1, r2, r3] = red;
const [b1, b2, b3] = blue;
r1.x = 131; r1.y = 437;
r2.x = 105; r2.y = 420;
r3.x = 363; r3.y = 454;
b1.x = 250; b1.y = 430;   // 挡在红3 通道上
b2.x = 390; b2.y = 470;   // 贴住红3
b3.x = 200; b3.y = 300;   // 中路压迫
for (const p of [...g.playersA(), ...g.playersB()]) { p.vx = 0; p.vy = 0; p.ctrl = false; p.receive = null; p.preCand = null; }
const ball = g.ball();
ball.x = 131; ball.y = 437; ball.vx = 0; ball.vy = 0; ball.alt = 0; ball.altV = 0;
ball.ctrl = r1; ball.lastTouch = r1; r1.ctrl = true;

// —— 跑 20s,观察红队如何破局 ——
global.__passEvts.length = 0;
const traces = [];
for (let i = 0; i < 60 * 20; i++) {
  g.step(1 / 60);
  if (i % 30 === 0) {  // 每 0.5s 记录球位置/控球者/红1位置
    const c = ball.ctrl;
    traces.push({ t: +g.simT().toFixed(1), bx: +ball.x.toFixed(0), by: +ball.y.toFixed(0),
      ctrl: c ? g.nameOf(c) : '-', r1: [+r1.x.toFixed(0), +r1.y.toFixed(0)] });
  }
}
console.log('传球/解围事件:');
for (const e of global.__passEvts) console.log(`  [${+e.t.toFixed(1)}s] ${e.from} → ${e.to}`);
console.log('\n球轨迹(每0.5s):');
console.log(traces.map(t => `[${t.t}s] ${t.ctrl}@(${t.bx},${t.by})`).join('\n'));

// —— 判定 ——
const evts = global.__passEvts;
let longest = 0, cur = 0, prevPair = null;
for (const e of evts) {
  const pair = `${e.from}->${e.to}`;
  if (prevPair && pair === rev(prevPair)) cur++;
  else cur = 1;
  prevPair = pair;
  longest = Math.max(longest, cur);
}
const escapes = traces.filter(t => t.bx > 300).length;
const clears = evts.filter(e => e.to === 'CLEAR').length;
console.log(`\n最长同对互传链: ${longest} 脚 | 解围: ${clears} 次 | 球离开角旗区(x>300)样本: ${escapes}/${traces.length}`);
console.log(longest <= 3 ? '结论: 互传循环被打破 ✓' : '结论: 仍有 4+ 脚互传 ✗');
function rev(p) { const [a, b] = p.split('->'); return `${b}->${a}`; }
