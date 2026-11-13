// 내 주식 노트 · 텔레그램 대화형 봇 (맥북 또는 윈도우 PC에서 실행)
// config.json 에 claude.apiKey 가 있으면 정해진 명령 외의 말은 Claude가 알아듣고 처리 (ai.mjs)
// 실행: node bot.mjs   (같은 폴더의 config.json 의 telegram 설정 사용)
// 등록된 내 채팅(chatId)에서 온 메시지에만 답합니다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptJSON, encryptJSON } from './brokers.mjs';
import { UA, kstNow, r2, dailyBars, weightedReturn, rsFromCut, classify, riskPlan } from './strategy-lib.mjs';
import { createAI } from './ai.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// 윈도우 PC 로컬 모드: GitHub 대신 저장소 폴더의 파일을 직접 읽고 씀
const LOCAL = process.env.STOCKNOTE_LOCAL === '1';
const ROOT = path.resolve(DIR, '..');
const CFG = JSON.parse(await fs.readFile(process.env.STOCKNOTE_CONFIG || path.join(DIR, 'config.json'), 'utf8'));
const TG = CFG.telegram || {};
if (!TG.token || !TG.chatId) { console.error('config.json 에 telegram 설정이 없어요. 먼저 node setup-bot.mjs 를 실행하세요.'); process.exit(1); }
const log = (...a) => console.log(new Date().toLocaleString('ko-KR'), '|', ...a);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const won = (v) => (v == null || !isFinite(v) ? '–' : Math.round(v).toLocaleString('ko-KR'));
const sgn = (v) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('ko-KR'));
const pct = (v) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
const man = (v) => (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + '억' : Math.round(v / 1e4).toLocaleString('ko-KR') + '만');
const today = () => kstNow().toISOString().slice(0, 10);

// ---------------------------------------------------------------- GitHub
const GH = CFG.github;
async function gh(method, p, body, raw = false) {
  const res = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}${p}`, {
    method,
    headers: { Authorization: `Bearer ${GH.token}`, Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'stock-note-bot' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`GitHub ${method} ${p}: HTTP ${res.status}`);
  return raw ? res.text() : res.json();
}
const cache = new Map();
async function file(p, ttl = 60000) {
  const c = cache.get(p);
  if (c && Date.now() - c.at < ttl) return c.v;
  const t = LOCAL ? await fs.readFile(path.join(ROOT, p), 'utf8').catch(() => null) : await gh('GET', `/contents/${p}?ref=${GH.branch || 'main'}`, null, true);
  const v = t == null ? null : JSON.parse(t);
  cache.set(p, { v, at: Date.now() });
  return v;
}
const enc = async (p) => { const box = await file(p); return box ? decryptJSON(box, CFG.password) : null; };
async function saveLocal(p, text) {
  await fs.writeFile(path.join(ROOT, p), text);
  cache.delete(p);
  // GitHub 사이트 반영은 local/run.mjs 가 몇 분마다 모아서 올림
}
async function saveRaw(p, obj, message) {
  if (LOCAL) return saveLocal(p, JSON.stringify(obj));
  const cur = await gh('GET', `/contents/${p}?ref=${GH.branch || 'main'}`);
  await gh('PUT', `/contents/${p}`, { message, content: Buffer.from(JSON.stringify(obj)).toString('base64'), sha: cur?.sha, branch: GH.branch || 'main' });
  cache.delete(p);
}
async function saveJSON(p, obj, message) {
  if (LOCAL) return saveLocal(p, JSON.stringify(obj, null, 2) + '\n');
  const cur = await gh('GET', `/contents/${p}?ref=${GH.branch || 'main'}`);
  await gh('PUT', `/contents/${p}`, { message, content: Buffer.from(JSON.stringify(obj, null, 2) + '\n').toString('base64'), sha: cur?.sha, branch: GH.branch || 'main' });
  cache.delete(p);
}

// ---------------------------------------------------------------- 텔레그램
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
const reply = (text) => tg('sendMessage', { chat_id: TG.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

// ---------------------------------------------------------------- 공통 계산
let ALIASES = {};
const acctName = (broker, account) => ALIASES[`${broker}|${account}`] || (String(account).startsWith(broker) ? account : (broker === 'KIS' ? '한투 ' : broker + ' ') + account);
async function portfolio() {
  const [sum, hold] = await Promise.all([file('data/summary.json'), enc('data/holdings.enc.json')]);
  if (!sum || !hold) throw new Error('데이터를 불러오지 못했어요');
  ALIASES = hold.aliases || {};
  const px = Object.fromEntries(sum.stocks.map((s) => [s.code, s]));
  const fx = sum.fx?.USDKRW || 0;
  const acc = {};
  for (const h of hold.items) {
    const s = px[h.code]; if (!s && !h.self) continue;
    const k = h.currency === 'USD' ? fx : 1;
    const key = acctName(h.broker, h.account || h.broker);
    const o = acc[key] ||= { v: 0, c: 0, today: 0, cash: null, items: [] };
    const v = h.self ? h.valueKrw : s.close * h.qty * k, c = h.self ? h.costKrw : h.avg * h.qty * k;
    o.v += v; o.c += c;
    o.today += h.self ? (h.dailyRate != null ? v - v / (1 + h.dailyRate / 100) : 0) : (s.close - s.close / (1 + s.changePct / 100)) * h.qty * k;
    o.items.push({ name: h.name, v, pl: v - c, rate: c ? (v / c - 1) * 100 : 0 });
  }
  for (const a of hold.accounts || []) { const o = acc[acctName(a.broker, a.account)] ||= { v: 0, c: 0, today: 0, cash: null, items: [] }; if (a.cash != null) o.cash = (o.cash || 0) + a.cash; }
  return { acc, sum, fx };
}
async function lookup(q) {
  q = q.trim();
  const [sig, sum, hold] = await Promise.all([file('data/signals.json'), file('data/summary.json'), enc('data/holdings.enc.json').catch(() => null)]);
  const names = { ...(sig?.names || {}) };
  for (const s of sum?.stocks || []) names[s.code] = s.name;
  for (const h of hold?.items || []) names[h.code] = h.name;
  if (names[q.toUpperCase()]) return { code: q.toUpperCase(), name: names[q.toUpperCase()] };
  const exact = Object.entries(names).find(([, n]) => n === q);
  if (exact) return { code: exact[0], name: exact[1] };
  const part = Object.entries(names).filter(([, n]) => n.replace(/\s/g, '').toLowerCase().includes(q.replace(/\s/g, '').toLowerCase()));
  if (part.length === 1) return { code: part[0][0], name: part[0][1] };
  if (part.length > 1) return { many: part.slice(0, 8).map(([c, n]) => `${n}(${c})`) };
  if (/^\d{6}$/.test(q)) {
    try { const j = await (await fetch(`https://m.stock.naver.com/api/stock/${q}/basic`, { headers: UA })).json(); if (j.stockName) return { code: q, name: j.stockName }; } catch {}
  }
  if (/^[A-Za-z.]{1,6}$/.test(q)) return { code: q.toUpperCase(), name: q.toUpperCase(), us: true };
  return null;
}
async function yahooBars(sym) {
  const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: UA })).json();
  const r = j?.chart?.result?.[0]; if (!r) throw new Error('미국 시세를 찾지 못했어요');
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 })).filter((b) => b.close != null);
}
async function analyze(code, us) {
  const strategy = await file('config/strategy.json');
  const sig = await file('data/signals.json');
  const bars = us ? await yahooBars(code) : await dailyBars(code);
  const raw = weightedReturn(bars.map((b) => b.close));
  const rs = us ? null : rsFromCut(raw, sig?.rsCut);
  return { ...classify(bars, strategy, rs), rs, strategy, bars };
}

// ---------------------------------------------------------------- 명령
const HELP = `<b>내 주식 노트 봇</b> — 이렇게 보내 보세요
• <b>현황</b> — 총자산·계좌별 평가와 오늘 손익
• <b>계좌</b> — 계좌별 보유 종목 손익
• <b>실현</b> [이번달·지난달·올해·3개월·전체] — 실현손익
• <b>신호</b> — 오늘 돌파·관찰 종목
• <b>분석 삼성전자</b> — 종목의 Stage·피벗·손절가
• <b>감시</b> / <b>감시 추가 삼성전자</b> [가격] / <b>감시 삭제 삼성전자</b>
• <b>기준</b> / <b>기준 RS 80</b> — 스캔 기준 보기·바꾸기
• <b>입금 한투1 100만</b> [날짜] / <b>출금 키움(미국) 50만</b> / <b>입출금</b> — 수익률 계산용 입출금 기록
• <b>알림 끄기</b> [오늘·3일·계속] / <b>알림 켜기</b> — 돌파 알림
• <b>공시알림 끄기</b> / <b>공시알림 켜기</b> — 보유 종목 공시·리포트 알림
• <b>신용</b> — 코스피·코스닥 신용잔고 최근 5일 · <b>신용알림 끄기/켜기</b>
${CFG.claude?.apiKey || CFG.anthropicKey ? '\n💬 그 밖에는 평소 말하듯 보내도 돼요. 예) "이번 달 한투1 실현손익 얼마야?", "보유 종목 중 52주 고가 근처인 거 있어?", "SNT다이내믹스 감시 걸어줘"\n바꾸는 일은 "네"라고 확인한 뒤에 실행해요. 주문은 할 수 없어요.' : ''}`;

const KEYS = {
  RS: ['minRS', '최소 RS'], 시총: ['minMarketCapEok', '최소 시가총액(억)'], 거래량: ['breakout.volumeRatio', '돌파 거래량 배수'],
  조정기간: ['base.maxDays', '최대 조정 기간(거래일)'], 조정폭: ['base.maxDepthPct', '최대 조정폭(%)'], 관찰범위: ['watchWithinPct', '피벗 아래 관찰 범위(%)'],
  손절: ['risk.maxStopPct', '최대 손절폭(%)'], 리스크: ['risk.riskPerTradePct', '1회 최대 손실(총자산 %)'], 손익비: ['risk.rewardRisk', '목표 손익비'], 추격: ['breakout.maxExtendedPct', '피벗 위 추격 허용(%)'],
};
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] ||= {}), o)[last] = v; };

async function cmdStatus(detail) {
  const { acc, sum } = await portfolio();
  const keys = Object.keys(acc).sort();
  const T = keys.reduce((t, k) => ({ v: t.v + acc[k].v, c: t.c + acc[k].c, cash: t.cash + (acc[k].cash || 0), today: t.today + acc[k].today }), { v: 0, c: 0, cash: 0, today: 0 });
  const lines = [`<b>💼 현황</b> (${new Date(sum.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 기준)`,
    `총자산 <b>${won(T.v + T.cash)}원</b> (주식 ${man(T.v)} + 예수금 ${man(T.cash)})`,
    `평가손익 ${sgn(T.v - T.c)}원 (${pct(T.c ? (T.v / T.c - 1) * 100 : 0)}) · 오늘 ${sgn(T.today)}원`, ''];
  for (const k of keys) {
    const o = acc[k];
    lines.push(`<b>${esc(k)}</b> ${man(o.v + (o.cash || 0))} · 손익 ${pct(o.c ? (o.v / o.c - 1) * 100 : 0)} · 오늘 ${sgn(o.today)}`);
    if (detail) for (const it of o.items.sort((a, b) => b.v - a.v)) lines.push(`  · ${esc(it.name)} ${man(it.v)} (${pct(it.rate)})`);
  }
  return lines.join('\n');
}

async function cmdRealized(arg) {
  const R = await enc('data/realized.enc.json');
  ALIASES = (await enc('data/holdings.enc.json').catch(() => null))?.aliases || ALIASES;
  if (!R) return '실현손익 데이터가 아직 없어요.';
  const t = today(), y = t.slice(0, 4), m = t.slice(0, 7);
  const back = (d) => new Date(kstNow().getTime() - d * 86400000).toISOString().slice(0, 10);
  const lastMonth = (() => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  const P = { 오늘: [t, t], 이번주: [back((kstNow().getUTCDay() + 6) % 7), t], 이번달: [`${m}-01`, t], 지난달: [`${lastMonth}-01`, `${lastMonth}-31`], 올해: [`${y}-01-01`, t], '1개월': [back(31), t], '3개월': [back(92), t], '6개월': [back(183), t], '1년': [back(366), t], 전체: ['2000-01-01', t] };
  const key = Object.keys(P).find((k) => (arg || '').includes(k)) || '이번달';
  const [f, to] = P[key];
  const rows = R.rows.filter((r) => r.date >= f && r.date <= to).map((r) => ({ ...r, net: r.pl - r.fee - r.tax }));
  if (!rows.length) return `${key} 실현손익 내역이 없어요.`;
  const net = rows.reduce((s, r) => s + r.net, 0), wins = rows.filter((r) => r.pl > 0).length;
  const byAcc = {}, byStock = {};
  rows.forEach((r) => { const a = acctName(r.broker, r.account); byAcc[a] = (byAcc[a] || 0) + r.net; byStock[r.name] = (byStock[r.name] || 0) + r.net; });
  const top = Object.entries(byStock).sort((a, b) => b[1] - a[1]);
  return [`<b>💰 실현손익 · ${key}</b> (${f} ~ ${to})`, `순손익 <b>${sgn(net)}원</b> · ${rows.length}건 · 승률 ${Math.round(wins / rows.length * 100)}%`, '',
    ...Object.entries(byAcc).map(([a, v]) => `${esc(a)}: ${sgn(v)}원`), '',
    '<b>잘한 종목</b>', ...top.slice(0, 3).map(([n, v]) => `  · ${esc(n)} ${sgn(v)}`),
    ...(top.at(-1)?.[1] < 0 ? ['<b>아쉬운 종목</b>', ...top.slice(-3).reverse().filter(([, v]) => v < 0).map(([n, v]) => `  · ${esc(n)} ${sgn(v)}`)] : [])].join('\n');
}

async function cmdSignals() {
  const s = await file('data/signals.json');
  if (!s) return '스캔 결과가 아직 없어요.';
  const L = [`<b>📊 신호</b> (기준일 ${s.asOf})`];
  const al = s.intraday?.alerts || [];
  if (al.length) L.push('', '<b>오늘 장중 돌파</b>', ...al.map((a) => `🚀 ${esc(a.name)} ${a.time} ${won(a.price)} (피벗 ${won(a.pivot)})`));
  L.push('', `<b>종가 돌파</b> ${s.breakouts.length}개`, ...s.breakouts.slice(0, 8).map((b) => `📈 ${esc(b.name)} ${won(b.price)} · 거래량 ${b.volRatio}배 · RS ${b.rs}`));
  L.push('', `<b>2 Stage 관찰</b> ${s.stage2.length}개`, ...s.stage2.slice(0, 10).map((b) => `👀 ${esc(b.name)} 피벗 ${won(b.pivot)} (−${b.toPivotPct}%) · RS ${b.rs}`));
  if ((s.custom || []).length) L.push('', '<b>내 감시</b>', ...s.custom.map((c) => `⭐ ${esc(c.name)} ${won(c.price)} → ${won(c.trigger)}${c.toTriggerPct != null ? ` (${c.toTriggerPct > 0 ? '−' : '+'}${Math.abs(c.toTriggerPct)}%)` : ''}`));
  return L.join('\n');
}

async function cmdAnalyze(q) {
  if (!q) return '종목명을 같이 보내 주세요. 예) 분석 삼성전자';
  const f = await lookup(q);
  if (!f) return `"${esc(q)}" 종목을 찾지 못했어요. 6자리 코드로 보내 보세요.`;
  if (f.many) return `여러 종목이 있어요: ${f.many.map(esc).join(', ')}`;
  const a = await analyze(f.code, f.us);
  const t = a.trend, b = a.base, d = a.today, S = a.strategy;
  if (!t) return `${esc(f.name)}: 상장 기간이 짧아 분석할 데이터가 부족해요.`;
  const entry = a.pivot && a.stage.startsWith('2') ? a.pivot : d.close;
  const plan = b ? riskPlan(entry, b, S, null) : null;
  const unit = f.us ? '$' : '';
  const f2 = (v) => (f.us ? v?.toFixed(2) : won(v));
  return [`<b>🔎 ${esc(f.name)}</b> ${f.code}`, `판정: <b>${a.stage}</b>`,
    `현재가 ${unit}${f2(d.close)} (${d.date}) · RS ${a.rs ?? '–'}`,
    `52주 고가 ${unit}${f2(t.high52)} 대비 ${pct((d.close / t.high52 - 1) * 100)} · 정배열 ${t.aligned ? '✅' : '❌'}`,
    `20일선 ${f2(t.ma20)} · 50일선 ${f2(t.ma50)} · 200일선 ${f2(t.ma200)}`,
    b ? `베이스: 고점 ${unit}${f2(b.pivot)} (${b.pivotDate}) 이후 ${b.days}일 · 조정 ${b.depthPct}% · 직전 상승 ${b.advancePct}%${b.tight ? ' · 변동성 수축' : ''}${b.volDry ? ' · 거래량 감소' : ''}` : '',
    a.pivot ? `피벗 ${unit}${f2(a.pivot)} · 돌파 기준 거래량 ${S.breakout.volumeRatio}배 (50일 평균 ${won(b.avgVol50)}주)` : '',
    plan ? `${a.stage.startsWith('2') ? '피벗 매수 시' : '지금 매수 시'} 손절 ${unit}${f2(plan.stop)} (${plan.stopPct}%) · 목표 ${unit}${f2(plan.target)} (+${plan.targetPct}%)` : '',
    `\n감시하려면: 감시 추가 ${esc(f.name)}`].filter(Boolean).join('\n');
}

async function cmdWatch(args) {
  const alerts = (await file('config/alerts.json', 0)) || { paused: false, custom: [] };
  alerts.custom ||= [];
  const [sub, ...rest] = args;
  if (!sub) {
    if (!alerts.custom.length) return '내 감시 목록이 비어 있어요. 예) 감시 추가 삼성전자 210000';
    return ['<b>⭐ 내 감시 목록</b>', ...alerts.custom.map((c) => `· ${esc(c.name)} (${c.code}) ${c.price ? `${won(c.price)} 돌파 시` : `피벗 ${won(c.pivot)} 거래량 동반 돌파 시`}`)].join('\n');
  }
  if (/^(추가|등록)$/.test(sub)) {
    const priceTok = rest.length > 1 && /^[\d,.]+원?$/.test(rest.at(-1)) ? rest.pop() : null;
    const price = priceTok ? Number(priceTok.replace(/[,원]/g, '')) : null;
    const f = await lookup(rest.join(' '));
    if (!f) return `"${esc(rest.join(' '))}" 종목을 찾지 못했어요.`;
    if (f.many) return `여러 종목이 있어요: ${f.many.map(esc).join(', ')}`;
    if (f.us) return '미국 종목 감시는 아직 지원하지 않아요. (국내 종목만)';
    const a = await analyze(f.code, false);
    const entry = { code: f.code, name: f.name, price, pivot: a.base ? Math.round(a.base.pivot) : null, avgVol50: a.base?.avgVol50 || null, baseLow: a.base?.recentLow || null, addedAt: today() };
    alerts.custom = alerts.custom.filter((c) => c.code !== f.code).concat(entry);
    await saveJSON('config/alerts.json', alerts, `봇: 감시 추가 ${f.name}`);
    return `⭐ <b>${esc(f.name)}</b> 감시를 시작해요.\n${price ? `${won(price)}원을 넘으면` : `피벗 ${won(entry.pivot)}원을 거래량 동반 돌파하면`} 장중에 알려드릴게요. (현재가 ${won(a.today.close)})`;
  }
  if (/^(삭제|제거|빼기)$/.test(sub)) {
    const q = rest.join(' ');
    const before = alerts.custom.length;
    alerts.custom = alerts.custom.filter((c) => c.code !== q && c.name !== q && !c.name.includes(q));
    if (alerts.custom.length === before) return `"${esc(q)}"는 감시 목록에 없어요.`;
    await saveJSON('config/alerts.json', alerts, `봇: 감시 삭제 ${q}`);
    return `"${esc(q)}" 감시를 멈췄어요.`;
  }
  return '감시 / 감시 추가 종목 [가격] / 감시 삭제 종목 중에서 보내 주세요.';
}

async function cmdCriteria(args) {
  const S = await file('config/strategy.json', 0);
  if (!args.length) return ['<b>⚙️ 스캔 기준</b>', ...Object.entries(KEYS).map(([k, [p, label]]) => `· ${k}: ${getPath(S, p)}  (${label})`), '', '바꾸기 예) 기준 RS 80 · 기준 거래량 2'].join('\n');
  const [k, v] = args;
  const def = KEYS[k] || KEYS[k?.toUpperCase()];
  const val = Number(String(v || '').replace(/[,%배억일]/g, ''));
  if (!def) return `바꿀 수 있는 항목: ${Object.keys(KEYS).join(', ')}`;
  if (!Number.isFinite(val) || val <= 0) return '숫자를 같이 보내 주세요. 예) 기준 RS 80';
  const old = getPath(S, def[0]);
  setPath(S, def[0], val);
  await saveJSON('config/strategy.json', S, `봇: 기준 변경 ${k} ${old} → ${val}`);
  return `✅ ${def[1]}: ${old} → <b>${val}</b>\n다음 장 마감 스캔부터 반영돼요.`;
}

async function cmdAlerts(on, arg) {
  const alerts = (await file('config/alerts.json', 0)) || { custom: [] };
  if (on) { alerts.paused = false; alerts.pausedUntil = null; }
  else {
    alerts.paused = true;
    const n = Number((arg || '').match(/(\d+)\s*일/)?.[1]);
    alerts.pausedUntil = /계속|무기한/.test(arg || '') ? null : new Date(kstNow().getTime() + ((n || 1) - 1) * 86400000).toISOString().slice(0, 10);
  }
  await saveJSON('config/alerts.json', alerts, `봇: 알림 ${on ? '켜기' : '끄기'}`);
  return on ? '🔔 알림을 다시 켰어요.' : `🔕 알림을 ${alerts.pausedUntil ? alerts.pausedUntil + '까지' : '켤 때까지'} 멈췄어요. "알림 켜기"로 다시 켤 수 있어요.`;
}

// 입출금 직접 기록 → data/flows.enc.json (암호화). 자산 추이의 추정값 대신 사용
async function cmdFlow(kind, args) {
  const hold = await enc('data/holdings.enc.json');
  ALIASES = hold?.aliases || {};
  const keys = new Set([...(hold?.items || []).map((h) => `${h.broker}|${h.account || h.broker}`), ...(hold?.accounts || []).map((a) => `${a.broker}|${a.account}`)]);
  const named = [...keys].map((k) => { const [b, a] = k.split('|'); return [k, acctName(b, a)]; });
  const flows = (await enc('data/flows.enc.json').catch(() => null)) || { rows: [] };
  if (kind === 'list') {
    const rows = flows.rows.slice(-15).reverse();
    return rows.length ? ['<b>💵 직접 기록한 입출금</b>', ...rows.map((r) => `· ${r.date} ${esc(named.find(([k]) => k === r.account)?.[1] || r.account)} ${r.amount > 0 ? '입금' : '출금'} ${won(Math.abs(r.amount))}원`), '', '지우기: 입출금 삭제 2026-11-12 한투1'].join('\n') : '직접 기록한 입출금이 없어요. 예) 입금 한투1 1000000';
  }
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || today();
  const rest = args.filter((a) => a !== date);
  const amtTok = rest.find((a) => /^[\d,]+(원|만원?)?$/.test(a));
  const name = rest.filter((a) => a !== amtTok).join(' ');
  const hit = named.filter(([, n]) => n === name || n.replace(/\s/g, '') === name.replace(/\s/g, '') || n.includes(name));
  if (hit.length !== 1) return `계좌를 정확히 적어 주세요: ${named.map(([, n]) => n).join(', ')}`;
  if (kind === 'delete') {
    const before = flows.rows.length;
    flows.rows = flows.rows.filter((r) => !(r.date === date && r.account === hit[0][0]));
    if (before === flows.rows.length) return `${date} ${esc(hit[0][1])} 기록이 없어요.`;
  } else {
    if (!amtTok) return '금액을 적어 주세요. 예) 입금 한투1 1000000 (또는 100만)';
    let amount = Number(amtTok.replace(/[,원만]/g, '')) * (/만/.test(amtTok) ? 10000 : 1);
    if (kind === 'out') amount = -amount;
    flows.rows = flows.rows.filter((r) => !(r.date === date && r.account === hit[0][0])).concat({ date, account: hit[0][0], amount });
    flows.rows.sort((a, b) => a.date.localeCompare(b.date));
  }
  await saveRaw('data/flows.enc.json', encryptJSON(flows, CFG.password), `봇: 입출금 기록`);
  return kind === 'delete' ? `${date} ${esc(hit[0][1])} 입출금 기록을 지웠어요.` : `💵 ${date} <b>${esc(hit[0][1])}</b> ${kind === 'in' ? '입금' : '출금'} ${won(Math.abs(Number(amtTok.replace(/[,원만]/g, '')) * (/만/.test(amtTok) ? 10000 : 1)))}원을 기록했어요.\n자산 추이 수익률에 바로 반영돼요 (사이트 새로고침).`;
}

async function cmdCredit() {
  const c = await file('data/credit.json', 300000);
  if (!c?.rows?.length) return '신용잔고 자료가 아직 없어요.';
  const r = c.rows, last = r.at(-1);
  const jo = (m) => (m / 1e6).toFixed(2) + '조';
  const eok = (m) => { const v = Math.round(m / 100); return (v > 0 ? '+' : v < 0 ? '-' : '±') + Math.abs(v).toLocaleString('ko-KR') + '억'; };
  const L = [`<b>📊 신용거래융자 잔고</b> (${last.date} 기준)`, `코스피 <b>${jo(last.kospi)}</b> · 코스닥 <b>${jo(last.kosdaq)}</b>`, '', '<b>최근 5거래일</b> (전일 대비)'];
  for (let i = r.length - 1; i >= Math.max(1, r.length - 5); i--) L.push(`${r[i].date.slice(5)}  코스피 ${jo(r[i].kospi)} ${eok(r[i].kospi - r[i - 1].kospi)} · 코스닥 ${jo(r[i].kosdaq)} ${eok(r[i].kosdaq - r[i - 1].kosdaq)}`);
  return L.join('\n');
}
async function cmdCreditAlert(on) {
  const alerts = (await file('config/alerts.json', 0)) || { custom: [] };
  alerts.credit = on;
  await saveJSON('config/alerts.json', alerts, `봇: 신용잔고 알림 ${on ? '켜기' : '끄기'}`);
  return on ? '📊 장 마감 신용잔고 그래프 알림을 켰어요.' : '신용잔고 알림을 껐어요. "신용알림 켜기"로 다시 켤 수 있어요.';
}

async function cmdNews(on) {
  const alerts = (await file('config/alerts.json', 0)) || { custom: [] };
  alerts.news = on;
  await saveJSON('config/alerts.json', alerts, `봇: 공시·리포트 알림 ${on ? '켜기' : '끄기'}`);
  return on ? '📢 보유 종목 공시·리포트 알림을 켰어요.' : '공시·리포트 알림을 껐어요. "공시알림 켜기"로 다시 켤 수 있어요.';
}

// ---------------------------------------------------------------- 자연어(Claude)용 데이터
async function holdingsJSON() {
  const [sum, hold] = await Promise.all([file('data/summary.json'), enc('data/holdings.enc.json')]);
  ALIASES = hold?.aliases || {};
  const px = Object.fromEntries((sum?.stocks || []).map((s) => [s.code, s]));
  const fx = sum?.fx?.USDKRW || 0;
  const rows = [];
  for (const h of hold?.items || []) {
    const s = px[h.code]; const k = h.currency === 'USD' ? fx : 1;
    const value = h.self ? h.valueKrw : s ? s.close * h.qty * k : null;
    const cost = h.self ? h.costKrw : h.avg * h.qty * k;
    rows.push({ account: acctName(h.broker, h.account || h.broker), name: h.name, code: h.code, currency: h.currency || 'KRW', qty: h.qty, avg: h.avg, price: s?.close ?? h.price ?? null,
      valueKrw: value == null ? null : Math.round(value), plKrw: value == null ? null : Math.round(value - cost), ratePct: value && cost ? r2((value / cost - 1) * 100) : null,
      changePct: s?.changePct, high52: s?.high52, distToHigh52Pct: s?.distToHigh52Pct, ma20: s?.ma20, ma60: s?.ma60, ma120: s?.ma120, ret3mPct: s?.ret3mPct, trend: s?.trend?.label, stop: s?.stop });
  }
  const total = rows.reduce((t, r) => t + (r.valueKrw || 0), 0);
  for (const r of rows) r.weightPct = total && r.valueKrw ? r2(r.valueKrw / total * 100) : null;
  const cash = (hold?.accounts || []).map((a) => ({ account: acctName(a.broker, a.account), cash: a.cash }));
  return { asOf: sum?.updatedAt, usdkrw: fx, holdings: rows, cash };
}
async function realizedRows({ from, to, account, stock } = {}) {
  const R = await enc('data/realized.enc.json');
  if (!R) return { rows: [] };
  let rows = R.rows.map((r) => ({ date: r.date, account: acctName(r.broker, r.account), name: r.name, code: r.code, qty: r.qty, sellAmt: r.sellAmt, pl: r.pl, net: r.pl - (r.fee || 0) - (r.tax || 0), rate: r.rate }));
  if (from) rows = rows.filter((r) => r.date >= from);
  if (to) rows = rows.filter((r) => r.date <= to);
  if (account) rows = rows.filter((r) => r.account.replace(/\s/g, '').includes(account.replace(/\s/g, '')));
  if (stock) rows = rows.filter((r) => r.name.includes(stock) || r.code === stock);
  return { count: rows.length, netSum: rows.reduce((t, r) => t + r.net, 0), rows: rows.slice(0, 150) };
}
async function historyRows({ from, to } = {}) {
  const H = await enc('data/history.enc.json');
  let d = (H?.days || []).map((x) => ({ date: x.date, total: x.total, stockValue: x.stockValue, cash: x.cash, cost: x.cost }));
  if (from) d = d.filter((x) => x.date >= from);
  if (to) d = d.filter((x) => x.date <= to);
  return { days: d.slice(-120) };
}
async function stockInfo(q) {
  const f = await lookup(q || '');
  if (!f || f.many) return { error: f?.many ? `여러 종목: ${f.many.join(', ')}` : '종목을 찾지 못했어요' };
  const d = await file(`data/stocks/${f.code}.json`, 600000).catch(() => null);
  if (!d) return { code: f.code, name: f.name, error: '상세 자료가 없는 종목이에요 (보유·신호 종목만 자료가 있어요). analyze_stock 은 쓸 수 있어요.' };
  return { code: d.code, name: d.name, info: d.info, annual: d.annual, quarter: d.quarter, summary: d.summary, deals: (d.deals || []).slice(0, 5), researches: (d.researches || []).slice(0, 5) };
}
async function disclosures(q) {
  const sum = await file('data/summary.json');
  let list = sum?.disclosures || [];
  if (q) list = list.filter((x) => JSON.stringify(x).includes(q));
  return list.slice(0, 30);
}
const AI = createAI({
  config: CFG.claude || (CFG.anthropicKey ? { apiKey: CFG.anthropicKey } : {}),
  log, today, cmdStatus, cmdRealized, cmdSignals, cmdAnalyze, cmdWatch, cmdCriteria, cmdFlow, cmdAlerts, cmdNews,
  holdingsJSON, realizedRows, historyRows, stockInfo, disclosures,
  creditData: async () => { const c = await file('data/credit.json', 300000); return c ? { asOf: c.asOf, unit: c.unit, rows: c.rows.slice(-130) } : { error: '자료 없음' }; },
  accountNames: () => [...new Set(Object.values(ALIASES))],
  criteriaKeys: () => Object.keys(KEYS),
  criteriaLabel: (k) => KEYS[k]?.[1] || k,
});

async function handle(text) {
  if (AI.enabled) {
    const c = await AI.confirm(text);
    if (c) return c.html;
  }
  const t = text.trim().replace(/^\//, '');
  const [cmd, ...args] = t.split(/\s+/);
  if (/^(도움|도움말|help|start|명령어)$/i.test(cmd)) return HELP;
  if (/^(현황|잔고|자산|status)$/i.test(cmd)) return cmdStatus(false);
  if (/^(계좌|계좌별)$/.test(cmd)) return cmdStatus(true);
  if (/^(실현|실현손익|수익)$/.test(cmd)) return cmdRealized(args.join(' '));
  if (/^(신호|시그널|signals?)$/i.test(cmd)) return cmdSignals();
  if (/^(분석|종목|조회)$/.test(cmd)) return cmdAnalyze(args.join(' '));
  if (/^감시$/.test(cmd)) return cmdWatch(args);
  if (/^입금$/.test(cmd)) return cmdFlow('in', args);
  if (/^출금$/.test(cmd)) return cmdFlow('out', args);
  if (/^입출금$/.test(cmd)) return args[0] === '삭제' ? cmdFlow('delete', args.slice(1)) : cmdFlow('list', args);
  if (/^기준$/.test(cmd)) return cmdCriteria(args);
  if (/^(공시알림|공시|리포트알림)$/.test(cmd) && /끄|켜/.test(args[0] || '')) return cmdNews(/켜/.test(args[0]));
  if (/^(신용알림|신용잔고알림)$/.test(cmd) && /끄|켜/.test(args[0] || '')) return cmdCreditAlert(/켜/.test(args[0]));
  if (/^(신용|신용잔고|빚투)$/.test(cmd)) return cmdCredit();
  if (/^알림$/.test(cmd) && /끄|중지|멈/.test(args[0] || '')) return cmdAlerts(false, args.slice(1).join(' '));
  if (/^알림$/.test(cmd) && /켜|시작|재개/.test(args[0] || '')) return cmdAlerts(true);
  // 종목명만 보내면 분석
  const f = await lookup(t).catch(() => null);
  if (f && !f.many) return cmdAnalyze(t);
  // 그 밖의 말은 Claude가 알아듣고 처리 (API 키가 있을 때)
  if (AI.enabled) {
    if (!ALIASES || !Object.keys(ALIASES).length) ALIASES = (await enc('data/holdings.enc.json').catch(() => null))?.aliases || {};
    const r = await AI.answer(text);
    if (r) return { plain: r.text };
  }
  return `무슨 말인지 잘 모르겠어요.\n\n${HELP}`;
}

// ---------------------------------------------------------------- 공시 채널 감시 (t.me/darthacking)
// 채널 미리보기 페이지(t.me/s/채널)를 1분마다 확인해서, 글에 들어 있는 종목코드(A123456)가
// 내 보유 종목이면 바로 보내요. 처음 켤 때는 지금까지 글은 건너뛰고 새 글부터 봐요.
const CHANNELS = CFG.channels || ['darthacking'];
const CH_STATE = LOCAL ? path.join(ROOT, 'local', 'channel-state.json') : path.join(DIR, 'channel-state.json');
const unesc = (t) => t.replace(/<br\s*\/?>/g, '\n').replace(/<a [^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
async function channelPosts(ch, after) {
  const html = await (await fetch(`https://t.me/s/${ch}${after ? `?after=${after}` : ''}`, { headers: UA })).text();
  const out = [];
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const id = Number(block.match(/data-post="[^"/]+\/(\d+)"/)?.[1]);
    const body = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (id && body) out.push({ id, text: unesc(body).trim() });
  }
  return out.sort((a, b) => a.id - b.id);
}
async function heldCodes() {
  const hold = await enc('data/holdings.enc.json').catch(() => null);
  const m = new Map();
  for (const h of hold?.items || []) if (/^\d{6}$/.test(h.code)) m.set(h.code, h.name);
  return m;
}
async function watchChannels() {
  let state = {};
  try { state = JSON.parse(await fs.readFile(CH_STATE, 'utf8')); } catch {}
  for (;;) {
    const hr = kstNow().getUTCHours();
    const busy = hr >= 6 && hr < 22;
    try {
      const alerts = await file('config/alerts.json', 300000).catch(() => null);
      if (alerts?.news !== false && CFG.channelWatch !== false) {
        const held = await heldCodes();
        for (const ch of CHANNELS) {
          let last = state[ch];
          if (!last) { const p = await channelPosts(ch); state[ch] = p.at(-1)?.id || 0; log(`공시 채널 @${ch} 감시 시작 (글 #${state[ch]} 이후부터)`); continue; }
          for (let page = 0; page < 10; page++) {
            const posts = (await channelPosts(ch, last)).filter((p) => p.id > last);
            if (!posts.length) break;
            for (const p of posts) {
              const codes = [...p.text.matchAll(/A(\d{6})\b/g)].map((m) => m[1]).filter((c) => held.has(c));
              if (codes.length) {
                const name = held.get(codes[0]);
                const body = p.text.length > 1500 ? p.text.slice(0, 1500) + '…' : p.text;
                await reply(`📢 <b>보유 종목 공시 · ${esc(name)}</b>\n\n${esc(body)}\n\n<a href="https://t.me/${ch}/${p.id}">채널에서 보기</a>`);
                const rcp = p.text.match(/rcpNo=(\d+)/)?.[1];
                if (rcp) await markForwarded('D' + rcp).catch((e) => log('전달 기록 실패:', e.message));
                log(`공시 전달: ${name} (#${p.id})`);
              }
              last = p.id;
            }
          }
          state[ch] = last;
        }
        await fs.writeFile(CH_STATE, JSON.stringify(state));
      }
    } catch (e) { log('공시 채널 확인 실패:', e.message); }
    await new Promise((r) => setTimeout(r, busy ? 60000 : 600000));
  }
}
// GitHub 쪽 공시 알림(news.mjs)이 같은 공시를 또 보내지 않도록 전달한 접수번호를 암호화해 기록
async function markForwarded(id) {
  const cur = (await enc('data/forwarded.enc.json').catch(() => null)) || { ids: [] };
  if (cur.ids.includes(id)) return;
  cur.ids = [...cur.ids, id].slice(-500);
  cache.delete('data/forwarded.enc.json');
  await saveRaw('data/forwarded.enc.json', encryptJSON(cur, CFG.password), '봇: 공시 전달 기록');
}

// ---------------------------------------------------------------- 실행 루프
export { handle, channelPosts };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let offset = 0;
  log('봇을 시작했어요. 텔레그램에서 "도움"을 보내 보세요. (끄려면 Ctrl+C)');
  await reply('🤖 봇이 켜졌어요. "도움"을 보내면 할 수 있는 일을 알려드려요.').catch(() => {});
  watchChannels();
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text || String(m.chat.id) !== String(TG.chatId)) continue;
        log('받음:', m.text);
        try {
          tg('sendChatAction', { chat_id: TG.chatId, action: 'typing' }).catch(() => {});
          const out = await handle(m.text);
          if (out && typeof out === 'object' && out.plain != null) await tg('sendMessage', { chat_id: TG.chatId, text: out.plain.slice(0, 4000), disable_web_page_preview: true });
          else await reply(out);
        }
        catch (e) { log('처리 실패:', e.message); await reply(`처리 중 문제가 생겼어요: ${esc(e.message)}`); }
      }
    } catch (e) {
      log('연결 문제, 10초 후 다시 시도:', e.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}
