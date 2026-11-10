// 추세추종 스캐너 (Stage 1 → 2 → 3)
//
//   node scripts/scan.mjs daily          장 마감 후: 시총 기준 전종목 스캔 → data/signals.json, 텔레그램 요약
//   node scripts/scan.mjs intraday       장중: 2 Stage 관찰 종목의 피벗 돌파(거래량 동반) 감시 → 텔레그램 알림
//   node scripts/scan.mjs telegram-test  텔레그램 연결 확인 (봇에게 말을 건 채팅으로 chat id를 보내줌)
//   node scripts/scan.mjs daily --sample 인터넷 없이 가짜 데이터로 화면 확인용 파일 생성
//
// 기준값은 config/strategy.json. 외부 패키지 없음.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKISInvestor, decryptJSON } from './brokers.mjs';
import { UA, kstNow, ymd, r2, fetchText, dailyBars, sma, maxOf, minOf, ret, trendTemplate, baseInfo, riskPlan, weightedReturn } from './strategy-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] || 'daily';
const SAMPLE = process.argv.includes('--sample');
const ENV = process.env;
const SIGNALS = path.join(ROOT, 'data', 'signals.json');
const log = (...a) => console.log('[scan]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kstDate = () => kstNow().toISOString().slice(0, 10);
const fmt = (v) => Math.round(v).toLocaleString('ko-KR');

// ------------------------------------------------------------------ 데이터
// 네이버 증권(모바일) 시가총액 순위 API. 시총(억) 내림차순이라 기준 미만이 나오면 멈춤
async function universe(minCapEok) {
  const out = [];
  const n = (v) => Number(String(v ?? '').replace(/,/g, ''));
  for (const market of ['KOSPI', 'KOSDAQ']) {
    for (let page = 1; page <= 30; page++) {
      const j = JSON.parse(await fetchText(`https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`));
      const list = j.stocks || [];
      let stop = !list.length;
      for (const x of list) {
        const cap = n(x.marketValue);
        if (cap < minCapEok) { stop = true; break; }
        const name = String(x.stockName || '').trim();
        if (x.stockEndType && x.stockEndType !== 'stock') continue;          // ETF·ETN 등 제외
        if (x.tradeStopType?.code && x.tradeStopType.code !== '1') continue;  // 거래정지 제외
        if (/스팩|(\d*우[A-C]?)$|리츠$/.test(name)) continue;
        out.push({ code: x.itemCode, name, market, capEok: cap });
      }
      if (stop) break;
      await sleep(150);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 텔레그램
const ALERTS = await (async () => { try { return JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'alerts.json'), 'utf8')); } catch { return { paused: false, custom: [] }; } })();
const alertsPaused = () => ALERTS.paused && (!ALERTS.pausedUntil || ALERTS.pausedUntil >= kstDate());

async function telegram(text) {
  if (alertsPaused()) { log('알림 일시정지 중 → 전송 생략'); return false; }
  const token = ENV.TELEGRAM_BOT_TOKEN, chat = ENV.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('텔레그램 설정 없음 → 알림 생략'); return false; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) log('텔레그램 전송 실패:', res.status, (await res.text()).slice(0, 120));
  return res.ok;
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const SITE = ENV.SITE_URL || 'https://binbong1.github.io/stock-note/#/signals';

async function totalAsset() {
  if (!ENV.HOLDINGS_PASSWORD) return null;
  try {
    const h = decryptJSON(JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'history.enc.json'), 'utf8')), ENV.HOLDINGS_PASSWORD);
    return h.days?.at(-1)?.total || null;
  } catch { return null; }
}

function alertText(s, kind) {
  const p = s.plan || {};
  const flags = [s.base?.tight && '변동성 수축', s.base?.volDry && '거래량 감소', s.flow?.positive && '외인·기관 순매수'].filter(Boolean).join(' · ');
  return [
    s.isCustom && s.userPrice ? '⭐ <b>내 감시 가격 돌파</b>' : s.isCustom ? '⭐ <b>내 감시 종목 · 피벗 돌파</b>' : kind === 'intraday' ? '🚀 <b>3 Stage 돌파 (장중)</b>' : '📈 <b>3 Stage 돌파 (종가)</b>',
    `<b>${esc(s.name)}</b> ${s.code}${s.market ? ' · ' + s.market : ''}`,
    `현재가 ${fmt(s.price)}원 (${s.isCustom && s.userPrice ? '감시 가격' : '피벗'} ${fmt(s.pivot)} 대비 +${(s.price / s.pivot * 100 - 100).toFixed(1)}%)`,
    `거래량 ${s.volPace ?? s.volRatio}배 (50일 평균 대비${kind === 'intraday' ? ', 장 마감 환산' : ''})`,
    s.base?.days !== '-' && s.base?.days != null ? `RS ${s.rs ?? '-'} · 베이스 ${s.base.days}일 · 조정폭 ${s.base.depthPct}%${flags ? ' · ' + flags : ''}` : '',
    `손절 ${fmt(p.stop)} (${p.stopPct}%) · 목표 ${fmt(p.target)} (+${p.targetPct}%, 1:${CFG.risk.rewardRisk})`,
    p.shares != null ? `2% 룰 최대 ${p.shares.toLocaleString('ko-KR')}주 (약 ${fmt(p.amount / 10000)}만원)` : '',
    `<a href="${SITE}">신호 화면 열기</a>`,
  ].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------ 모드
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'strategy.json'), 'utf8'));
const KIS = ENV.KIS_APPKEY && ENV.KIS_APPSECRET && ENV.KIS_ACCOUNT ? { appkey: ENV.KIS_APPKEY, appsecret: ENV.KIS_APPSECRET, account: ENV.KIS_ACCOUNT } : null;

async function readSignals() {
  try { return JSON.parse(await fs.readFile(SIGNALS, 'utf8')); } catch { return { history: [] }; }
}
async function writeSignals(sig) {
  await fs.mkdir(path.dirname(SIGNALS), { recursive: true });
  await fs.writeFile(SIGNALS, JSON.stringify(sig));
}

function fakeUniverse() {
  const names = ['한화에어로스페이스', 'HD현대일렉트릭', '비에이치아이', '산일전기', '효성중공업', 'LS ELECTRIC', '두산에너빌리티', '현대로템', '삼양식품', '알테오젠', '리노공업', '클래시스'];
  return names.map((name, i) => ({ code: String(100000 + i * 1111).padStart(6, '0'), name, market: i % 3 ? 'KOSPI' : 'KOSDAQ', capEok: 90000 - i * 6000 }));
}
function fakeBars(seed, kind) {
  let x = seed, p = 20000;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out = [], d = new Date(kstNow().getTime() - 420 * 86400000);
  while (out.length < 290) {
    d.setUTCDate(d.getUTCDate() + 1);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const i = out.length;
    let drift = 0.003 + (seed % 5) * 0.0004;
    if (i > 268) drift = kind === 'down' ? -0.012 : -0.0015;     // 조정(베이스)
    if (i > 280) drift = kind === 'down' ? -0.004 : 0.0008;
    const o = p; p = p * (1 + drift + (rnd() - 0.5) * (i > 268 ? 0.008 : 0.02));
    out.push({ date: d.toISOString().slice(0, 10), open: o, high: Math.max(o, p) * (1 + rnd() * 0.01), low: Math.min(o, p) * (1 - rnd() * 0.01), close: p, volume: Math.round(300000 * (0.5 + rnd()) * (i > 270 ? 0.6 : 1)) });
  }
  if (kind === 'breakout') { const l = out.at(-1); l.close = maxOf(out.slice(-30).map((b) => b.high)) * 1.02; l.high = l.close * 1.01; l.volume *= 4; }
  return out;
}

async function daily() {
  const asOf = kstDate();
  const uni = SAMPLE ? fakeUniverse() : await universe(CFG.minMarketCapEok);
  log(`대상 종목 ${uni.length}개 (시총 ${CFG.minMarketCapEok}억 이상)`);
  const rows = [];
  for (const [i, s] of uni.entries()) {
    try {
      const bars = SAMPLE ? fakeBars(i * 7 + 3, ['breakout', 'flat', 'up', 'down'][i % 4]) : await dailyBars(s.code);
      if (bars.length < 230) continue;
      const c = bars.map((b) => b.close);
      const raw = weightedReturn(c);
      if (raw == null) continue;
      rows.push({ ...s, bars, rsRaw: raw, ret3m: r2(ret(c, 63) * 100) });
    } catch (e) { log(`건너뜀 ${s.name}: ${e.message}`); }
    if (!SAMPLE) await sleep(120);
    if (i % 100 === 99) log(`… ${i + 1}/${uni.length}`);
  }
  // RS 등급: 대상 종목 안에서 가중 수익률 백분위 (1~99)
  const sorted = [...rows].sort((a, b) => a.rsRaw - b.rsRaw);
  sorted.forEach((r, i) => { r.rs = Math.max(1, Math.min(99, Math.round((i + 1) / sorted.length * 99))); });
  const rsCut = Array.from({ length: 99 }, (_, k) => sorted.length ? r2(sorted[Math.min(sorted.length - 1, Math.floor((k + 1) / 100 * sorted.length))].rsRaw * 10000) / 10000 : 0);

  // 내가 직접 추가한 감시 종목(config/alerts.json): 조건과 상관없이 매일 피벗 계산
  const custom = [];
  for (const cu of ALERTS.custom || []) {
    try {
      const r = rows.find((x) => x.code === cu.code);
      const bars = r?.bars || (SAMPLE ? fakeBars(7, 'flat') : await dailyBars(cu.code));
      const base = baseInfo(bars, CFG), today = bars.at(-1);
      const trigger = cu.price || (base ? Math.round(base.pivot) : null);
      custom.push({ code: cu.code, name: cu.name, price: today.close, date: today.date, userPrice: cu.price || null, pivot: base ? Math.round(base.pivot) : null, trigger,
        rs: r?.rs ?? null, base: base ? { ...base, recentLow: minOf(bars.slice(-10).map((x) => x.low)) } : null, toTriggerPct: trigger ? r2((trigger / today.close - 1) * 100) : null });
    } catch (e) { log(`감시 종목 분석 실패 ${cu.name}: ${e.message}`); }
  }

  const stage1 = [], stage2 = [], breakouts = [];
  for (const r of rows) {
    if (r.rs < CFG.minRS) continue;
    const b = r.bars, today = b.at(-1);
    const t = trendTemplate(b, CFG);
    if (ENV.SCAN_DEBUG) { const bb = baseInfo(b, CFG), pb = baseInfo(b.slice(0, -1), CFG); log('DBG', r.name, 'rs', r.rs, 'trend', t?.ok, t?.aligned, 'base', JSON.stringify(bb && { ok: bb.ok, days: bb.days, adv: bb.advancePct, dep: bb.depthPct }), 'prev', JSON.stringify(pb && { ok: pb.ok, days: pb.days, adv: pb.advancePct, dep: pb.depthPct, piv: Math.round(pb.pivot) }), 'close', Math.round(today.close)); }
    if (!t?.ok) continue;
    const common = { code: r.code, name: r.name, market: r.market, capEok: r.capEok, rs: r.rs, ret3m: r.ret3m, price: today.close, date: today.date, ma20: Math.round(t.ma20), ma50: Math.round(t.ma50), high52: Math.round(t.high52) };
    if (t.daysSince52wHigh <= 10) stage1.push({ ...common, daysSince52wHigh: t.daysSince52wHigh });

    // 3 Stage(오늘 돌파): 어제까지의 베이스 기준으로 판단
    const prevB = b.slice(0, -1), prevBase = baseInfo(prevB, CFG), prevTrend = trendTemplate(prevB, CFG);
    if (prevBase?.ok && prevTrend?.ok && today.close > prevBase.pivot) {
      const volRatio = prevBase.avgVol50 ? r2(today.volume / prevBase.avgVol50) : null;
      const ext = (today.close / prevBase.pivot - 1) * 100;
      if (volRatio >= CFG.breakout.volumeRatio && ext <= CFG.breakout.maxExtendedPct) {
        breakouts.push({ ...common, pivot: Math.round(prevBase.pivot), volRatio, base: { ...prevBase, recentLow: minOf(b.slice(-10).map((x) => x.low)) } });
        continue;
      }
    }
    // 2 Stage(관찰): 오늘까지의 베이스, 피벗 아래 watchWithinPct 이내
    const base = baseInfo(b, CFG);
    if (base?.ok && today.close <= base.pivot && today.close >= base.pivot * (1 - CFG.watchWithinPct / 100)) {
      stage2.push({ ...common, pivot: Math.round(base.pivot), toPivotPct: r2((base.pivot / today.close - 1) * 100), base: { ...base, recentLow: minOf(b.slice(-10).map((x) => x.low)) } });
    }
  }

  // 수급(외국인·기관 20일 순매수) — 한국투자증권 키가 있을 때만
  if (KIS && !SAMPLE) {
    for (const s of [...breakouts, ...stage2]) {
      try { const f = await fetchKISInvestor(KIS, s.code, 20); s.flow = { ...f, positive: f.foreign + f.institution > 0 }; }
      catch (e) { log(`수급 조회 실패 ${s.name}: ${e.message}`); break; }
    }
  } else if (SAMPLE) {
    [...breakouts, ...stage2].forEach((s, i) => { s.flow = { days: 20, foreign: (i % 3 - 1) * 50000, institution: (i % 2) * 30000, positive: i % 3 !== 0 }; });
  }

  const asset = SAMPLE ? 50000000 : await totalAsset();
  for (const s of breakouts) s.plan = riskPlan(s.price, s.base, CFG, asset);
  for (const s of stage2) s.plan = riskPlan(s.pivot, s.base, CFG, asset);
  // 사이트(공개)에 올라가는 파일에는 내 자산 기준 수량은 빼고 저장
  const pub = (s) => { const { plan, ...rest } = s; const { shares, amount, ...p } = plan || {}; return { ...rest, plan: p }; };

  stage2.sort((a, b) => a.toPivotPct - b.toPivotPct || b.rs - a.rs);
  stage1.sort((a, b) => b.rs - a.rs);
  breakouts.sort((a, b) => b.rs - a.rs);

  const prev = await readSignals();
  const history = [...breakouts.map((s) => ({ date: asOf, kind: 'close', code: s.code, name: s.name, price: s.price, pivot: s.pivot, rs: s.rs, volRatio: s.volRatio })), ...(prev.history || []).filter((h) => !(h.kind === 'close' && h.date === asOf))].slice(0, 200);
  const sig = {
    updatedAt: new Date().toISOString(), asOf: rows[0]?.bars.at(-1).date || asOf, sample: SAMPLE, criteria: CFG,
    universe: uni.length, analyzed: rows.length,
    breakouts: breakouts.map(pub), stage2: stage2.map(pub), stage1: stage1.slice(0, 40), custom, rsCut,
    names: Object.fromEntries(uni.map((u) => [u.code, u.name])),
    intraday: prev.intraday?.date === asOf ? prev.intraday : { date: asOf, alerts: [] },
    history,
  };
  await writeSignals(sig);
  log(`완료: 3 Stage 돌파 ${breakouts.length} · 2 Stage 관찰 ${stage2.length} · 1 Stage ${stage1.length}`);

  // 장 마감 요약·종가 돌파 알림은 거래일마다 한 번만 (같은 날 스캔을 다시 돌려도 재전송 안 함)
  const alreadySent = prev.summarySentFor === sig.asOf;
  sig.summarySentFor = prev.summarySentFor;
  const closed = kstNow().toISOString().slice(11, 16) >= '15:30' || sig.asOf < kstDate();
  if (!SAMPLE && alreadySent) log(`${sig.asOf} 요약은 이미 보냈어요 → 생략`);
  if (!SAMPLE && !closed) log('장 마감 전이라 요약을 보내지 않아요');
  if (!SAMPLE && !alreadySent && closed) {
    sig.summarySentFor = sig.asOf;
    await writeSignals(sig);
    for (const s of breakouts) await telegram(alertText(s, 'close'));
    const top = stage2.slice(0, 10).map((s) => `· ${esc(s.name)} 피벗 ${fmt(s.pivot)} (−${s.toPivotPct}%) RS ${s.rs}`).join('\n');
    await telegram(`📋 <b>장 마감 스캔 ${sig.asOf}</b>\n3 Stage 돌파 ${breakouts.length}개 · 2 Stage 관찰 ${stage2.length}개\n${top ? '\n<b>내일 돌파 감시 (피벗 가까운 순)</b>\n' + top : ''}\n<a href="${SITE}">전체 보기</a>`);
  }
}

async function intraday() {
  const now = kstNow(), hm = now.toISOString().slice(11, 16), today = kstDate();
  if ([0, 6].includes(now.getUTCDay()) || hm < CFG.intraday.start || hm > CFG.intraday.end) { log(`장중 감시 시간이 아니에요 (${hm})`); return; }
  const sig = await readSignals();
  const customCodes = new Set((ALERTS.custom || []).map((c) => c.code));
  // 봇으로 방금 추가한 종목은 아직 일일 스캔 결과가 없을 수 있어 alerts.json 값으로 대신 감시
  const custom = (ALERTS.custom || []).map((cu) => {
    const sc = (sig.custom || []).find((c) => c.code === cu.code);
    if (sc && (!cu.price || sc.userPrice === cu.price)) return sc;
    return { code: cu.code, name: cu.name, userPrice: cu.price || null, trigger: cu.price || cu.pivot || null, rs: null,
      base: cu.avgVol50 ? { avgVol50: cu.avgVol50, baseLow: cu.baseLow || null, days: '-', depthPct: '-' } : null };
  }).filter((c) => c.trigger);
  const watch = [...(sig.stage2 || []).filter((w) => !customCodes.has(w.code)), ...custom.map((c) => ({ ...c, pivot: c.trigger, isCustom: true }))];
  if (!watch.length) { log('관찰 종목이 없어요'); return; }
  if (alertsPaused()) { log('알림 일시정지 중'); return; }
  if (sig.intraday?.date !== today) sig.intraday = { date: today, alerts: [] };
  const done = new Set(sig.intraday.alerts.map((a) => a.code));
  const elapsed = Math.min(1, Math.max(0.05, ((now.getUTCHours() - 9) * 60 + now.getUTCMinutes()) / 390));
  const asset = await totalAsset();
  let changed = false, checked = 0;
  for (const w of watch) {
    if (done.has(w.code)) continue;
    try {
      const bars = await dailyBars(w.code, 10);
      const t = bars.at(-1);
      if (!t || t.date !== today) { log('오늘 시세가 없어요 (휴장일?)'); return; }
      checked++;
      const pace = w.base?.avgVol50 ? r2(t.volume / elapsed / w.base.avgVol50) : 0;
      const ext = (t.close / w.pivot - 1) * 100;
      // 내가 가격을 정해 둔 감시 종목은 거래량 조건 없이 그 가격 돌파만 확인
      const volOk = w.isCustom && w.userPrice ? true : pace >= CFG.breakout.volumeRatio;
      if (t.close > w.pivot && volOk && ext <= CFG.breakout.maxExtendedPct) {
        const s = { ...w, price: t.close, volPace: pace, plan: riskPlan(t.close, w.base || { baseLow: t.close * 0.93 }, CFG, asset), base: w.base || { days: '-', depthPct: '-' } };
        await telegram(alertText(s, 'intraday'));
        const rec = { date: today, time: hm, kind: 'intraday', code: w.code, name: w.name, price: t.close, pivot: w.pivot, rs: w.rs, volRatio: pace };
        sig.intraday.alerts.push(rec);
        sig.history = [rec, ...(sig.history || [])].slice(0, 200);
        changed = true;
        log(`돌파 알림: ${w.name} ${t.close} > ${w.pivot} (거래량 ${pace}배)`);
      }
    } catch (e) { log(`조회 실패 ${w.name}: ${e.message}`); }
    await sleep(120);
  }
  log(`감시 ${checked}종목 · 새 알림 ${changed ? sig.intraday.alerts.length : 0}개`);
  if (changed) { sig.intraday.updatedAt = new Date().toISOString(); await writeSignals(sig); }
}

async function telegramTest() {
  const token = ENV.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 시크릿이 없어요');
  const me = await (await fetch(`https://api.telegram.org/bot${token.trim()}/getMe`)).json();
  if (!me.ok) { log(`봇 토큰이 맞지 않아요 (${me.description}). BotFather가 준 토큰 전체(숫자:문자)를 다시 등록하세요.`); process.exitCode = 1; return; }
  log(`봇 확인: @${me.result.username}`);
  const r = await (await fetch(`https://api.telegram.org/bot${token.trim()}/getUpdates`)).json();
  if (!r.ok) log('getUpdates 실패:', r.description);
  const chats = [...new Set((r.result || []).map((u) => (u.message || u.channel_post || {}).chat?.id).filter(Boolean))];
  if (ENV.TELEGRAM_CHAT_ID) {
    const ok = await telegram('✅ 내 주식 노트 알림 연결 완료! 3 Stage 돌파가 생기면 여기로 알려드릴게요.');
    log(ok ? '테스트 메시지 전송 성공' : '전송 실패 — chat id 확인 필요');
    return;
  }
  if (!chats.length) { log(`@${me.result.username} 봇에게 온 메시지가 없어요. 텔레그램에서 @${me.result.username} 를 검색해 [시작] 누르고 아무 말이나 보낸 뒤 다시 실행하세요.`); process.exitCode = 1; return; }
  for (const id of chats) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text: `연결 확인 메시지예요.\n아래 숫자를 GitHub Secrets의 TELEGRAM_CHAT_ID 로 등록하세요:\n\n${id}` }),
    });
  }
  log(`봇에게 말을 건 채팅 ${chats.length}곳에 chat id를 보냈어요 (로그에는 표시하지 않음)`);
}

if (MODE === 'daily') await daily();
else if (MODE === 'intraday') await intraday();
else if (MODE === 'telegram-test') await telegramTest();
else { console.error('모드: daily | intraday | telegram-test'); process.exit(1); }
