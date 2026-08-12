#!/usr/bin/env node
/**
 * 自动化评估迭代管线
 *
 * 用法:
 *   node tools/eval.js                          # 内置 6 套配置(均衡+5 战术),每套 3 场
 *   node tools/eval.js --rounds 5               # 每套 5 场
 *   node tools/eval.js --configs tools/configs/example.json
 *                                              # 只跑自定义配置(可叠加内置,逗号分隔)
 *
 * 流程:
 *   1. 从 涌现式足球demo-3v3.html 抽取游戏逻辑(单一真源,不改 demo)
 *   2. 无头跑对局(每场 90s),收集统计
 *   3. 写出 data/runs/<时间戳>/ 下的 JSON 明细 + MD 报告
 *   4. 清理旧轮数据(只保留最新一轮)
 *
 * 迭代循环(数值由实验决定,不拍脑袋):
 *   跑对局 → 读报告 → (由 LLM/人在对话中分析) → 调参数/改规则 → 重跑
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, '涌现式足球demo-3v3.html');
const DATA_DIR = path.join(ROOT, 'data', 'runs');

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { rounds: 3, configs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rounds') args.rounds = parseInt(argv[i + 1], 10) || 3;
    else if (argv[i] === '--configs') args.configs = argv[i + 1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}

// ---------- 内置配置(与 demo 面板战术预设一致) ----------
const BUILTIN = {
  balanced: { name: '均衡', tun: {} },
  tiki: { name: '传控', tun: { pass: 1.6, shoot: 0.6, wo: 0.35, wc: 0.45, wp: 0.1, wW: 0.2, wL: 0.15, dDeny: 0.45, dOpen: 0.25, dLane: 0.3, wind: 0.8, dLine: 0.42, press: 1.1, sDepth: 0.6, loft: 0.3 } },
  counter: { name: '防守反击', tun: { pass: 1.2, shoot: 1.3, trick: 1.2, dribble: 1.1, wo: 0.25, wc: 0.2, wp: 0.35, wW: 0.16, dDeny: 0.4, dLine: 0.22, press: 0.4, sDepth: 1.2, loft: 0.8 } },
  longball: { name: '长传反击', tun: { pass: 0.8, shoot: 1.3, trick: 0.5, dribble: 0.8, wo: 0.2, wc: 0.15, wp: 0.38, wW: 0.2, dLine: 0.25, press: 0.4, sDepth: 1.35, loft: 2 } },
  gegen: { name: '高位逼抢', tun: { wo: 0.28, wc: 0.32, wW: 0.08, dOpen: 0.35, dLane: 0.25, rep: 260, stag: 0.9, dLine: 0.52, press: 1.6, sDepth: 0.7, loft: 0.6 } }
};

// ---------- DOM 桩(无头运行游戏逻辑) ----------
function makeCtx() {
  return new Proxy({}, { get: (t, k) => (...a) => {}, set: () => true });
}
function makeEl() {
  return {
    textContent: '', innerHTML: '', style: {}, checked: false,
    classList: { add() {}, remove() {} },
    children: [], lastChild: { remove() {} },
    prepend() {}, appendChild() {}, addEventListener() {},
    querySelectorAll: () => [], querySelector: () => null,
    getContext: () => makeCtx()
  };
}

function loadGameCode() {
  const html = fs.readFileSync(DEMO, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('demo 中未找到 <script>');
  return m[1];
}

// ---------- 单场模拟 ----------
function runMatch(code, tun, seedLog) {
  const ctx2d = makeCtx();
  const elements = {};
  global.document = {
    getElementById: (id) => elements[id] || (elements[id] = makeEl()),
    createElement: () => makeEl(),
    body: makeEl(),
    querySelectorAll: () => [], querySelector: () => null
  };
  global.performance = { now: () => 0 };
  global.requestAnimationFrame = () => {};
  global.Blob = class {}; global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };

  const tail = `
global.__g = { kickoff, step, scoreA: () => scoreA, scoreB: () => scoreB,
  possA: () => possA, possB: () => possB, playersA: () => playersA, playersB: () => playersB,
  logHistory, TUN, transT };
`;
  new Function(code + tail)();
  const g = global.__g;
  g.kickoff();
  Object.assign(g.TUN, tun);  // 应用配置
  g.transT.A = 0; g.transT.B = 0;
  for (let i = 0; i < 60 * 90; i++) g.step(1 / 60);  // 90 分钟
  return g;
}

// ---------- 统计提取 ----------
function collect(g) {
  const cnt = (s) => g.logHistory.filter(e => e.msg.includes(s)).length;
  const players = [...g.playersA(), ...g.playersB()].map(p => p.stats);
  const sum = (k) => players.reduce((a, s) => a + s[k], 0);
  const passTot = sum('pass'), passOk = sum('passOk');
  const trickTot = sum('trick'), trickOk = sum('trickOk');
  const tackTot = sum('tackle'), tackOk = sum('tackleOk');
  const intcTot = sum('intc'), intcOk = sum('intcOk');
  const headTot = sum('header'), headOk = sum('headerOk');
  const poss = g.possA() + g.possB() > 0 ? Math.round(g.possA() / (g.possA() + g.possB()) * 100) : 50;
  return {
    score: `${g.scoreA()}:${g.scoreB()}`,
    goals: cnt('队进球'),
    shots: cnt('射门!'),
    groundPass: cnt('传球 →'),
    loft: cnt('高空球'),
    headers: cnt('头球!'),
    intc: cnt('拦截!') + cnt('封堵!'),
    tack: cnt('抢断'),
    trickWon: cnt('过掉'),
    possRed: poss,
    pass: passTot, passPct: passTot ? Math.round(passOk / passTot * 100) : 0,
    trickPct: trickTot ? Math.round(trickOk / trickTot * 100) : 0,
    tackPct: tackTot ? Math.round(tackOk / tackTot * 100) : 0,
    intcPct: intcTot ? Math.round(intcOk / intcTot * 100) : 0,
    headPct: headTot ? Math.round(headOk / headTot * 100) : 0
  };
}

// ---------- 统计汇总 ----------
function aggregate(matches) {
  const keys = Object.keys(matches[0]);
  const out = {};
  for (const k of keys) {
    const vals = matches.map(m => m[k]);
    if (typeof vals[0] === 'number') {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      out[k] = { mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
    } else {
      out[k] = vals;
    }
  }
  return out;
}

// ---------- 报告生成 ----------
function buildReport(runDir, results) {
  const keys = ['goals', 'shots', 'groundPass', 'loft', 'headers', 'intc', 'tack', 'trickWon', 'possRed', 'pass', 'passPct', 'trickPct', 'tackPct', 'intcPct', 'headPct'];
  const lines = [];
  lines.push('# 自动化评估报告');
  lines.push('');
  lines.push(`- 生成时间: ${new Date().toLocaleString()}`);
  lines.push(`- 每套配置场数: ${results[0].agg.goals.mean >= 0 ? '' : ''}${results[0].matches.length}`);
  lines.push('');
  lines.push('## 对比表(均值 ± 标准差)');
  lines.push('');
  lines.push('| 配置 | 比分 | 进球 | 射门 | 地面传球 | 高空球 | 传球成功率% | 头球 | 拦截 | 抢断 | 过人成功 | 控球(红)% |');
  lines.push('|------|------|------|------|---------|--------|-----------|------|------|------|---------|-----------|');
  for (const r of results) {
    const a = r.agg;
    const scoreStr = a.score.join(' / ');
    lines.push(`| **${r.name}** | ${scoreStr} | ${fmt(a.goals)} | ${fmt(a.shots)} | ${fmt(a.groundPass)} | ${fmt(a.loft)} | ${fmt(a.passPct)} | ${fmt(a.headers)} | ${fmt(a.intc)} | ${fmt(a.tack)} | ${fmt(a.trickWon)} | ${fmt(a.possRed)} |`);
  }
  lines.push('');
  lines.push('## 每场明细');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.name}`);
    lines.push('');
    lines.push('| 场次 | 比分 | 进球 | 射门 | 传球 | 成功率% | 高空 | 头球 | 拦截 | 抢断 | 过人 | 控球红% |');
    lines.push('|------|------|------|------|------|--------|------|------|------|------|------|--------|');
    r.matches.forEach((m, i) => {
      lines.push(`| ${i + 1} | ${m.score} | ${m.goals} | ${m.shots} | ${m.pass} | ${m.passPct} | ${m.loft} | ${m.headers} | ${m.intc} | ${m.tack} | ${m.trickWon} | ${m.possRed} |`);
    });
    lines.push('');
  }
  lines.push('## 给分析者(LLM/人)的观察问题');
  lines.push('');
  lines.push('1. 哪种配置的射门转化率最高/最低?为什么(结合传球成功率、高空球占比)?');
  lines.push('2. 传球成功率与拦截次数是否相关?防守配置(防线深度/逼抢强度)的影响是否可辨?');
  lines.push('3. 是否存在明显失衡(如某配置进球远高于其他)?是参数问题还是机制问题?');
  lines.push('4. 方差最大的指标是哪个?是否说明某些行为不稳定(抖动/扎堆)?');
  lines.push('5. 下一轮建议:改哪些参数、预期观察到什么变化?');
  lines.push('');
  return lines.join('\n');
}
function fmt(v) { return typeof v === 'object' ? `${v.mean}±${v.sd}` : String(v); }

// ---------- 数据清理:只保留最新一轮 ----------
function cleanOldRuns(runDir) {
  if (!fs.existsSync(DATA_DIR)) return;
  const dirs = fs.readdirSync(DATA_DIR).map(d => path.join(DATA_DIR, d)).filter(d => fs.statSync(d).isDirectory());
  const current = path.resolve(runDir);
  const removed = [];
  for (const d of dirs) {
    if (path.resolve(d) !== current) {
      fs.rmSync(d, { recursive: true, force: true });
      removed.push(path.basename(d));
    }
  }
  if (removed.length) console.log(`[清理] 已删除旧轮数据: ${removed.join(', ')}`);
}

// ---------- 主流程 ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const gameCode = loadGameCode();
  const configs = [];
  for (const k of Object.keys(BUILTIN)) configs.push({ key: k, ...BUILTIN[k], tun: { ...BUILTIN[k].tun } });
  for (const f of args.configs) {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(ROOT, f), 'utf8'));
    configs.push({ key: cfg.key || path.basename(f, '.json'), name: cfg.name || path.basename(f, '.json'), desc: cfg.desc || '', tun: cfg.tun || {} });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(DATA_DIR, stamp);
  fs.mkdirSync(runDir, { recursive: true });

  const results = [];
  for (const cfg of configs) {
    console.log(`[对局] ${cfg.name} × ${args.rounds} 场 ...`);
    const matches = [];
    for (let i = 0; i < args.rounds; i++) {
      const g = runMatch(gameCode, cfg.tun);
      matches.push(collect(g));
    }
    const out = { key: cfg.key, name: cfg.name, desc: cfg.desc || '', matches, agg: aggregate(matches) };
    fs.writeFileSync(path.join(runDir, `${cfg.key}.json`), JSON.stringify(out, null, 2), 'utf8');
    results.push(out);
  }

  const report = buildReport(runDir, results);
  fs.writeFileSync(path.join(runDir, 'report.md'), report, 'utf8');
  console.log(`[完成] 报告: data/runs/${stamp}/report.md`);
  console.log(report.split('\n').slice(0, 20).join('\n'));
  cleanOldRuns(runDir);
}

main();
