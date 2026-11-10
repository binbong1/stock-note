// 내 주식 노트 · 텔레그램 대화형 봇 (맥북에서 실행)
// 실행: node bot.mjs   (같은 폴더의 config.json 의 telegram 설정 사용)
// 등록된 내 채팅(chatId)에서 온 메시지에만 답합니다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptJSON } from './brokers.mjs';
import { UA, kstNow, r2, dailyBars, weightedReturn, rsFromCut, classify, riskPlan } from './strategy-lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(await fs.readFile(path.join(DIR, 'config.json'), 'utf8'));
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
  const t = await gh('GET', `/contents/${p}?ref=${GH.branch || 'main'}`, null, true);
  const v = t == null ? null : JSON.parse(t);
  cache.set(p, { v, at: Date.now() });
  return v;
}
const enc = async (p) => { const box = await file(p); return box ? decryptJSON(box, CFG.password) : null; };
async function saveJSON(p, obj, message) {
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
const acctName = (broker, account) => (String(account).startsWith(broker) ? account : (broker === 'KIS' ? '한투 ' : broker + ' ') + account);
async function portfolio() {
  const [sum, hold] = await Promise.all([file('data/summary.json'), enc('data/holdings.enc.json')]);
  if (!sum || !hold) throw new Error('데이터를 불러오지 못했어요');
  const px = Object.fromEntries(sum.stocks.map((s) => [s.code, s]));
  const fx = sum.fx?.USDKRW || 0;
  const acc = {};
  for (const h of hold.items) {
    const s = px[h.code]; if (!s) continue;
    const k = h.currency === 'USD' ? fx : 1;
    const key = acctName(h.broker, h.account || h.broker);
    const o = acc[key] ||= { v: 0, c: 0, today: 0, cash: null, items: [] };
    const v = s.close * h.qty * k, c = h.avg * h.qty * k;
    o.v += v; o.c += c; o.today += (s.close - s.close / (1 + s.changePct / 100)) * h.qty * k;
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
• <b>알림 끄기</b> [오늘·3일·계속] / <b>알림 켜기</b>`;

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
  return `✅ ${def[1]}: ${old} → <b>${val}</b>\n다음 장 마감 스캔(16:55)부터 반영돼요.`;
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

async function handle(text) {
  const t = text.trim().replace(/^\//, '');
  const [cmd, ...args] = t.split(/\s+/);
  if (/^(도움|도움말|help|start|명령어)$/i.test(cmd)) return HELP;
  if (/^(현황|잔고|자산|status)$/i.test(cmd)) return cmdStatus(false);
  if (/^(계좌|계좌별)$/.test(cmd)) return cmdStatus(true);
  if (/^(실현|실현손익|수익)$/.test(cmd)) return cmdRealized(args.join(' '));
  if (/^(신호|시그널|signals?)$/i.test(cmd)) return cmdSignals();
  if (/^(분석|종목|조회)$/.test(cmd)) return cmdAnalyze(args.join(' '));
  if (/^감시$/.test(cmd)) return cmdWatch(args);
  if (/^기준$/.test(cmd)) return cmdCriteria(args);
  if (/^알림$/.test(cmd) && /끄|중지|멈/.test(args[0] || '')) return cmdAlerts(false, args.slice(1).join(' '));
  if (/^알림$/.test(cmd) && /켜|시작|재개/.test(args[0] || '')) return cmdAlerts(true);
  // 종목명만 보내면 분석
  const f = await lookup(t).catch(() => null);
  if (f && !f.many) return cmdAnalyze(t);
  return `무슨 말인지 잘 모르겠어요.\n\n${HELP}`;
}

// ---------------------------------------------------------------- 실행 루프
export { handle };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let offset = 0;
  log('봇을 시작했어요. 텔레그램에서 "도움"을 보내 보세요. (끄려면 Ctrl+C)');
  await reply('🤖 봇이 켜졌어요. "도움"을 보내면 할 수 있는 일을 알려드려요.').catch(() => {});
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text || String(m.chat.id) !== String(TG.chatId)) continue;
        log('받음:', m.text);
        try { await reply(await handle(m.text)); }
        catch (e) { log('처리 실패:', e.message); await reply(`처리 중 문제가 생겼어요: ${esc(e.message)}`); }
      }
    } catch (e) {
      log('연결 문제, 10초 후 다시 시도:', e.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}
