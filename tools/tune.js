#!/usr/bin/env node
/**
 * 力场自动调参:以"力场 vs 旧逻辑对踢"为目标函数的随机搜索
 *
 * 用法:
 *   node tools/tune.js                       # 默认: 8 轮迭代, 每轮 3+3 场对踢
 *   node tools/tune.js --iters 20            # 20 轮
 *   node tools/tune.js --rounds 4            # 每轮 4+4 场
 *   node tools/tune.js --params "spaceStr,ballStr"   # 只调指定参数
 *
 * 目标:最大化 力场方总进球 - 旧逻辑方总进球(交叉:红新蓝旧 + 红旧蓝新)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, '涌现式足球demo-3v3.html');

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { iters: 8, rounds: 3, params: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--iters') args.iters = parseInt(argv[i + 1], 10) || 8;
    else if (argv[i] === '--rounds') args.rounds = parseInt(argv[i + 1], 10) || 3;
    else if (argv[i] === '--params') args.params = argv[i + 1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}

// ---------- DOM 桩 ----------
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

function loadGame() {
  const html = fs.readFileSync(DEMO, 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
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
global.__g = { kickoff, step, scoreA: () => scoreA, scoreB: () => scoreB,
  playersA: () => playersA, playersB: () => playersB, simT: () => simT,
  ball: () => ball, logHistory, TUN, AI_VER, FT };
`;
  new Function(code + tail)();
  elements.selNA = makeEl(); elements.selNA.value = '3';
  elements.selNB = makeEl(); elements.selNB.value = '3';
  elements.ckGK_A = makeEl(); elements.ckGK_A.checked = true;
  elements.ckGK_B = makeEl(); elements.ckGK_B.checked = true;
  return global.__g;
}

// ---------- 单场对踢评估 ----------
function evalMatch(g, aVer, bVer) {
  g.AI_VER.A = aVer; g.AI_VER.B = bVer;
  g.kickoff();
  g.step(0);
  for (let i = 0; i < 60 * 90; i++) g.step(1 / 60);
  const sc = { a: g.scoreA(), b: g.scoreB() };
  g.logHistory.length = 0;
  return sc;
}

// 评估:返回 力场-旧 的净进球(交叉平均,样本 rounds×2×2 场)
function evaluate(g, ft, rounds) {
  const base = { ...g.FT };
  Object.assign(g.FT, ft);
  let newG = 0, oldG = 0;
  for (let r = 0; r < rounds; r++) {
    let s1 = evalMatch(g, 'new', 'old'); newG += s1.a; oldG += s1.b;   // 红新蓝旧
    let s2 = evalMatch(g, 'old', 'new'); oldG += s2.a; newG += s2.b;   // 红旧蓝新
  }
  Object.assign(g.FT, base);
  return newG - oldG;
}

// ---------- 随机搜索 ----------
const ALL_PARAMS = {
  homeStr: [100, 500], homeShift: [0, 1], ballStr: [120, 500], goalStr: [150, 500],
  structK: [0.2, 0.9], structR: [70, 160], markBase: [120, 420],
  spaceStr: [150, 500], spaceBW: [40, 120], spaceAspect: [1, 2.5], chanStr: [120, 320],
  aggro: [0.5, 2], recoverRate: [1, 4]
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const params = args.params || Object.keys(ALL_PARAMS);
  const g = loadGame();
  const base = { ...g.FT };

  let best = { ft: { ...base }, score: evaluate(g, base, args.rounds) };
  console.log(`初始(基线参数): 净球差 ${best.score > 0 ? '+' : ''}${best.score}`);
  console.log(`搜索参数: ${params.join(', ')} | 每轮 ${args.rounds}+${args.rounds} 场`);

  const history = [];
  for (let it = 0; it < args.iters; it++) {
    // 随机扰动一个参数
    const k = params[Math.floor(Math.random() * params.length)];
    const [lo, hi] = ALL_PARAMS[k];
    let v = best.ft[k] * (1 + (Math.random() - 0.5) * 0.3);
    v = Math.max(lo, Math.min(hi, v));
    if (k === 'homeShift' || k === 'structK' || k === 'spaceAspect' || k === 'aggro' || k === 'recoverRate') v = +v.toFixed(2);
    else v = Math.round(v);

    const cand = { ...best.ft, [k]: v };
    const score = evaluate(g, cand, args.rounds);
    history.push({ it: it + 1, k, v, score });
    const delta = score - best.score;
    if (delta > 0) {
      best = { ft: cand, score };
      console.log(`  [${it + 1}] ${k}=${v} → 净球差 ${score > 0 ? '+' : ''}${score} (接受 ↑${delta})`);
    } else if (it % 4 === 0) {
      console.log(`  [${it + 1}] ${k}=${v} → ${score > 0 ? '+' : ''}${score} (拒绝)`);
    }
  }

  console.log('\n===== 最优结果 =====');
  console.log(`净球差: ${best.score > 0 ? '+' : ''}${best.score} (力场方每 ${args.rounds * 2} 场净胜 ${best.score} 球)`);
  console.log('参数:');
  for (const k of params) console.log(`  ${k} = ${best.ft[k]}`);
  console.log('\n(把以上参数写入 demo 的 FT 常量或面板即可)');
}

main();
