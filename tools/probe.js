#!/usr/bin/env node
/**
 * 无头探针:传球死循环 + 一脚出球/射门 + 贴边行为诊断
 *
 * 用法:
 *   node tools/probe.js --matches 6      # 夹采样点(修复)与不夹(对照)各 6 场
 *
 * 指标:
 *   1. 一脚出球/射门:占总传球/射门比、来球速度分布(验证"决策与球速无关,球速只影响精度")
 *   2. 传球死循环:连续同对互传链(≥4 脚)、链长/时长/贴边距离、是否自解(最后一脚传给第三人)
 *   3. 贴边:球员距边界 <60px 的时间占比、传球者贴边时的传球占比
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, '涌现式足球demo-3v3.html');

function parseArgs(argv) {
  const args = { matches: 6 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--matches') args.matches = parseInt(argv[i + 1], 10) || 6;
  }
  return args;
}

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

const CLAMPED = `    // 采样点夹回场内:场外不是"真空位"——边线外不可站人,不能把球员往界外吸
    const sx = clamp(p.x + Math.cos(ang) * dist, X0 + PR + 6, X1 - PR - 6);
    const sy = clamp(p.y + Math.sin(ang) * dist, Y0 + PR + 6, Y1 - PR - 6);`;
const UNCLAMPED = `    const sx = p.x + Math.cos(ang) * dist;
    const sy = p.y + Math.sin(ang) * dist;`;

function loadCode() {
  const html = fs.readFileSync(DEMO, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('demo 中未找到 <script>');
  return m[1].replace(/\r\n/g, '\n');  // 统一换行,便于字符串埋点
}

function makeVariant(baseCode, unclamp) {
  let code = baseCode;
  if (unclamp) {
    if (!code.includes(CLAMPED)) throw new Error('未找到 fieldSpace 夹取采样点代码,无法构造对照');
    code = code.replace(CLAMPED, UNCLAMPED);
  } else {
    if (!code.includes(CLAMPED)) throw new Error('未找到 fieldSpace 夹取采样点代码');
  }
  // 一脚出球/射门探针:接球瞬间的来球速度 inSp 是局部量,在标签赋值处钩出来
  const OT_HOOK = `p.label = a.type === 'shot' ? '一脚射门' : '一脚出球'; p.labelT = 0.7;`;
  if (!code.includes(OT_HOOK)) throw new Error('未找到一脚标签赋值,无法埋点');
  code = code.replace(OT_HOOK, OT_HOOK + ` globalThis.__ot.tick(a.type, inSp, simT);`);
  return code;
}

function runMatch(code) {
  const elements = {};
  global.document = {
    getElementById: (id) => elements[id] || (elements[id] = makeEl()),
    createElement: () => makeEl(), body: makeEl(),
    querySelectorAll: () => [], querySelector: () => null
  };
  global.performance = { now: () => 0 };
  global.requestAnimationFrame = () => {};
  global.Blob = class {}; global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
  globalThis.__ot = {
    pass: 0, shot: 0, speeds: [],
    tick(type, inSp) { if (type === 'pass') this.pass++; else this.shot++; this.speeds.push(inSp); }
  };
  const tail = `
globalThis.__passEvts = [];
const __origLog = log;
log = function (msg, cls) {
  __origLog(msg, cls);
  let m = /^(红|蓝)(\\d) (传球|高空球) → (红|蓝)(\\d)$/.exec(msg);
  if (m) {
    const from = m[1] + m[2], to = m[4] + m[5];
    const pf = [...playersA, ...playersB].find(p => nameOf(p) === from);
    const pt = [...playersA, ...playersB].find(p => nameOf(p) === to);
    globalThis.__passEvts.push({ t: simT, from, to, loft: m[3] === '高空球',
      fx: pf ? pf.x : -1, fy: pf ? pf.y : -1, tx: pt ? pt.x : -1, ty: pt ? pt.y : -1 });
  } else {
    m = /^(红|蓝)(\\d) (射门!|挑射!)$/.exec(msg);
    if (m) globalThis.__passEvts.push({ t: simT, from: m[1] + m[2], to: 'GOAL', loft: false, fx: -1, fy: -1, tx: -1, ty: -1 });
  }
};
global.__g = { kickoff, step, scoreA: () => scoreA, scoreB: () => scoreB,
  playersA: () => playersA, playersB: () => playersB, simT: () => simT, ball: () => ball };
`;
  new Function(code + tail)();
  const g = global.__g;
  elements.ckGK_A = makeEl(); elements.ckGK_A.checked = true;
  elements.ckGK_B = makeEl(); elements.ckGK_B.checked = true;
  g.kickoff();
  globalThis.__ot.pass = 0; globalThis.__ot.shot = 0; globalThis.__ot.speeds.length = 0;
  globalThis.__passEvts.length = 0;

  const X0 = 40, X1 = 920, Y0 = 30, Y1 = 570;  // 与 demo 常量一致
  const edgeDist = (x, y) => Math.min(x - X0, X1 - x, y - Y0, Y1 - y);
  let edgeSamples = 0, totalSamples = 0;
  for (let i = 0; i < 60 * 90; i++) {
    g.step(1 / 60);
    if (i % 15 === 0) {  // 每 0.25s 采样贴边
      for (const p of [...g.playersA(), ...g.playersB()]) {
        totalSamples++;
        if (edgeDist(p.x, p.y) < 60) edgeSamples++;
      }
    }
  }

  // —— 传球死循环检测:连续同对互传链 ——
  const evts = globalThis.__passEvts;
  const loops = [];
  const chainsAll = [];
  let chain = null;
  const flush = () => {
    if (chain) {
      chain.dur = +(chain.last.t - chain.first.t).toFixed(1);
      chain.selfResolved = false;
      for (let i = chain.idx + 1; i < evts.length; i++) {
        if (evts[i].from === chain.last.to) { chain.selfResolved = true; break; }
      }
      chainsAll.push(chain);
      if (chain.n >= 4) loops.push(chain);
    }
    chain = null;
  };
  for (let i = 0; i < evts.length; i++) {
    const e = evts[i];
    const samePair = chain && e.from === chain.last.to && e.to === chain.last.from && !e.loft && !chain.last.loft;
    if (samePair) { chain.n++; chain.last = e; chain.maxT = e.t; }
    else { flush(); chain = e.to === 'GOAL' ? null : { n: 1, first: e, last: e, idx: i, maxT: e.t }; }
  }
  flush();

  const passTotal = evts.filter(e => e.to !== 'GOAL').length;
  const shotTotal = evts.filter(e => e.to === 'GOAL').length;
  // 链长分布:2 脚互传 / 3 脚 / 4 脚 / 5+ 脚
  const chainHist = { n2: 0, n3: 0, n4: 0, n5: 0 };
  for (const c of chainsAll) {
    if (c.n === 2) chainHist.n2++;
    else if (c.n === 3) chainHist.n3++;
    else if (c.n === 4) chainHist.n4++;
    else chainHist.n5++;
  }
  const loopEdges = loops.map(l => {
    const es = evts.slice(l.idx, l.idx + l.n);
    const f = es.filter(e => e.fx > 0).map(e => edgeDist(e.fx, e.fy));
    return f.length ? Math.min(...f) : -1;
  });
  const passEdges = evts.filter(e => e.to !== 'GOAL' && e.fx > 0).map(e => edgeDist(e.fx, e.fy));

  return {
    score: `${g.scoreA()}:${g.scoreB()}`,
    otPass: globalThis.__ot.pass, otShot: globalThis.__ot.shot,
    otSpeeds: [...globalThis.__ot.speeds],
    passTotal, shotTotal,
    edgePct: totalSamples ? +(edgeSamples / totalSamples * 100).toFixed(1) : 0,
    passEdgePct: passEdges.length ? +(passEdges.filter(d => d < 60).length / passEdges.length * 100).toFixed(1) : 0,
    chainHist, loops, loopEdges
  };
}

function mean(a) { return a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0; }
function pct(a, b) { return b ? +(a / b * 100).toFixed(1) : 0; }

function summarize(matches) {
  const n = matches.length;
  const speeds = matches.flatMap(m => m.otSpeeds);
  const loops = matches.flatMap(m => m.loops);
  const loopEdges = matches.flatMap(m => m.loopEdges);
  const hist = { n2: 0, n3: 0, n4: 0, n5: 0 };
  for (const m of matches) for (const k of Object.keys(hist)) hist[k] += m.chainHist[k];
  return {
    n,
    score: matches.map(m => m.score).join(' '),
    otPassPct: pct(matches.reduce((a, m) => a + m.otPass, 0), matches.reduce((a, m) => a + m.passTotal, 0)),
    otShotPct: pct(matches.reduce((a, m) => a + m.otShot, 0), matches.reduce((a, m) => a + m.shotTotal, 0)),
    otSpeedMin: speeds.length ? +Math.min(...speeds).toFixed(0) : 0,
    otSpeedMean: mean(speeds),
    otSpeedMax: speeds.length ? +Math.max(...speeds).toFixed(0) : 0,
    edgePct: mean(matches.map(m => m.edgePct)),
    passEdgePct: mean(matches.map(m => m.passEdgePct)),
    chainHist: hist,
    loopCount: loops.length,
    loopPerMatch: +(loops.length / n).toFixed(2),
    loopLenMax: loops.length ? Math.max(...loops.map(l => l.n)) : 0,
    loopDurMax: loops.length ? Math.max(...loops.map(l => l.dur)) : 0,
    loopResolved: pct(loops.filter(l => l.selfResolved).length, loops.length),
    loopEdgeMin: mean(loopEdges.map(d => (d < 0 ? 60 : d)))
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = loadCode();
  for (const [label, unclamp] of [['修复(采样点夹回场内)', false], ['对照(不夹采样点)', true]]) {
    const code = makeVariant(base, unclamp);
    const ms = [];
    for (let i = 0; i < args.matches; i++) {
      try { ms.push(runMatch(code)); } catch (err) { console.error(`[${label}] 第 ${i + 1} 场崩溃: ${err.message}`); throw err; }
    }
    const s = summarize(ms);
    console.log(`\n===== ${label} · ${args.matches} 场 =====`);
    console.log(`比分: ${s.score}`);
    console.log(`一脚出球: ${s.otPassPct}% (${ms.reduce((a, m) => a + m.otPass, 0)}/${ms.reduce((a, m) => a + m.passTotal, 0)}) | 来球速度 min/mean/max = ${s.otSpeedMin}/${s.otSpeedMean}/${s.otSpeedMax}`);
    console.log(`一脚射门: ${s.otShotPct}% (${ms.reduce((a, m) => a + m.otShot, 0)}/${ms.reduce((a, m) => a + m.shotTotal, 0)})`);
    console.log(`贴边时间占比: ${s.edgePct}% | 传球者贴边(<60px)传球占比: ${s.passEdgePct}%`);
    console.log(`同对互传链长分布: 2脚=${s.chainHist.n2} 3脚=${s.chainHist.n3} 4脚=${s.chainHist.n4} 5脚+=${s.chainHist.n5}`);
    console.log(`死循环链(≥4脚同对互传): ${s.loopCount} 条 (场均 ${s.loopPerMatch}) | 最长链 ${s.loopLenMax} 脚 / ${s.loopDurMax}s | 自解率 ${s.loopResolved}% | 链传球者最小贴边距均值 ${s.loopEdgeMin}px`);
    const detail = ms.flatMap((m, i) => m.loops.map(l => `  [场${i + 1}] ${l.n}脚 ${l.dur}s 自解=${l.selfResolved ? '是' : '否'}`));
    if (detail.length) console.log(detail.join('\n'));
  }
}

main();
