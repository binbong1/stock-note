// 내 주식 노트 — 데이터 수집 스크립트
// GitHub Actions가 매일 장 마감 후 실행해서 data/summary.json 을 만듭니다.
// 외부 패키지 없이 Node.js 20 이상에서 동작합니다.
//
//   node scripts/collect.mjs           실제 데이터 수집
//   node scripts/collect.mjs --sample  인터넷 없이 가짜(샘플) 데이터로 화면 확인용 파일 생성

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fetchKIS, fetchKISRealized, encryptJSON, decryptJSON } from './brokers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.argv.includes('--sample');
const DART_KEY = process.env.DART_API_KEY || '';
const UA = { 'User-Agent': 'Mozilla/5.0 (stock-note personal dashboard)' };
const KR_MARKETS = { KOSPI: '.KS', KOSDAQ: '.KQ', KRX: '.KS' };
const ENV = process.env;

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const round = (v, n = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);
const log = (...a) => console.log('[collect]', ...a);

// ---------- 시세 가져오기 ----------

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// 네이버 금융 일봉 (국내 종목). 결과: [{date, open, high, low, close, volume}]
async function fromNaver(code) {
  const end = new Date();
  const start = new Date(end.getTime() - 800 * 86400000);
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${ymd(start)}&endTime=${ymd(end)}&timeframe=day`;
  const text = (await fetchText(url)).trim().replace(/'/g, '"').replace(/,\s*\]/g, ']');
  const rows = JSON.parse(text).slice(1);
  const bars = rows
    .filter((r) => r && r[4] != null)
    .map((r) => ({
      date: `${String(r[0]).slice(0, 4)}-${String(r[0]).slice(4, 6)}-${String(r[0]).slice(6, 8)}`,
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    }));
  if (bars.length < 30) throw new Error('네이버 데이터가 너무 적음');
  return bars;
}

// 야후 파이낸스 일봉 (미국 종목, 지수, 환율, 국내 종목 예비용)
async function fromYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  const json = JSON.parse(await fetchText(url));
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(`야후 응답 없음: ${symbol}`);
  const q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => {
    if (q.close[i] == null) return;
    bars.push({
      date: new Date((t + (r.meta.gmtoffset || 0)) * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0,
    });
  });
  if (bars.length < 30) throw new Error(`야후 데이터가 너무 적음: ${symbol}`);
  return bars;
}

async function getBars(stock) {
  if (KR_MARKETS[stock.market]) {
    try { return await fromNaver(stock.code); }
    catch (e) { log(`네이버 실패(${stock.name}) → 야후로 재시도:`, e.message); }
    try { return await fromYahoo(stock.code + KR_MARKETS[stock.market]); }
    catch (e) { if (stock.market !== 'KRX') throw e; }
    return fromYahoo(stock.code + '.KQ');
  }
  return fromYahoo(stock.code);
}

// ---------- 지표 계산 ----------

function smaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function atr(bars, n) {
  if (bars.length <= n) return null;
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  let a = tr.slice(1, n + 1).reduce((s, v) => s + v, 0) / n; // 와일더 방식
  for (let i = n + 1; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

const pctChange = (closes, back) =>
  closes.length > back ? closes.at(-1) / closes.at(-1 - back) - 1 : null;

export function analyze(bars, cfg, benchCloses) {
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const ma20 = smaSeries(closes, 20), ma60 = smaSeries(closes, 60), ma120 = smaSeries(closes, 120);

  const prior = bars.slice(-251, -1); // 오늘 제외 직전 약 52주(250거래일)
  const high52 = Math.max(...prior.map((b) => b.high));
  const volAvg20 = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  const volRatio = volAvg20 ? last.volume / volAvg20 : null;
  const atrV = atr(bars.slice(-120), cfg.atrPeriod);
  const recentHigh = Math.max(...closes.slice(-20));
  const stop = atrV != null ? recentHigh - cfg.atrMultiplier * atrV : null;
  const m20 = ma20.at(-1), m60 = ma60.at(-1), m120 = ma120.at(-1);

  const ret3m = pctChange(closes, 63);
  const benchRet3m = benchCloses ? pctChange(benchCloses, 63) : null;

  const checks = {
    breakout52w: last.close > high52,
    volumeSurge: volRatio != null && volRatio >= cfg.breakoutVolumeRatio,
    maAligned: m20 != null && m60 != null && m120 != null && m20 > m60 && m60 > m120,
    aboveMa20: m20 != null && last.close > m20,
    gapOk: m20 != null && Math.abs(last.close / m20 - 1) * 100 <= cfg.maxGapFromMa20Pct,
  };
  const distToStopPct = stop != null ? (last.close / stop - 1) * 100 : null;

  let trend;
  if (stop != null && last.close < stop) trend = { key: 'stop', label: '손절선 이탈' };
  else if (checks.breakout52w && checks.volumeSurge) trend = { key: 'breakout', label: '신고가 돌파' };
  else if (distToStopPct != null && distToStopPct <= cfg.nearStopPct) trend = { key: 'near-stop', label: '손절선 근접' };
  else if (checks.maAligned && checks.aboveMa20) trend = { key: 'up', label: '상승 추세 유지' };
  else if (!checks.aboveMa20) trend = { key: 'watch', label: '관망 · 20일선 아래' };
  else trend = { key: 'neutral', label: '중립' };

  const tail = 250;
  const sl = (arr) => arr.slice(-tail).map((v) => round(v, 2));
  return {
    date: last.date,
    close: last.close,
    changePct: round((last.close / prev.close - 1) * 100),
    high52: round(high52),
    distToHigh52Pct: round((last.close / high52 - 1) * 100),
    volume: last.volume,
    volRatio: round(volRatio),
    ma20: round(m20), ma60: round(m60), ma120: round(m120),
    gapFromMa20Pct: m20 ? round((last.close / m20 - 1) * 100) : null,
    atr: round(atrV), stop: round(stop), distToStopPct: round(distToStopPct),
    ret3mPct: round(ret3m * 100),
    rs3mPctPt: ret3m != null && benchRet3m != null ? round((ret3m - benchRet3m) * 100) : null,
    checks, trend,
    chart: {
      dates: bars.slice(-tail).map((b) => b.date),
      close: sl(closes), ma20: sl(ma20), ma60: sl(ma60), volume: vols.slice(-tail),
    },
  };
}

// ---------- DART 공시 ----------

// corpCode.xml(zip)에서 종목코드 → 고유번호 표를 만들고 data/corp_codes.json 에 저장해 둡니다.
function unzipFirst(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip 형식이 아님');
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const csize = buf.readUInt32LE(cd + 20);
  const lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

async function corpCodes(stockCodes) {
  const cacheFile = path.join(ROOT, 'data', 'corp_codes.json');
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch {}
  if (stockCodes.every((c) => c in cache)) return cache; // ETF 등 고유번호 없는 종목은 null 로 기억
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_KEY}`, { headers: UA });
  if (!res.ok) throw new Error(`DART corpCode HTTP ${res.status}`);
  const xml = unzipFirst(Buffer.from(await res.arrayBuffer())).toString('utf8');
  const re = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>[^<]*<\/corp_name>\s*(?:<corp_eng_name>[^<]*<\/corp_eng_name>\s*)?<stock_code>\s*(\d{6})\s*<\/stock_code>/g;
  for (const m of xml.matchAll(re)) if (stockCodes.includes(m[2])) cache[m[2]] = m[1];
  for (const c of stockCodes) if (!(c in cache)) cache[c] = null;
  await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
  return cache;
}

async function disclosures(stocks, days) {
  if (!DART_KEY) { log('DART_API_KEY 가 없어 공시 수집을 건너뜁니다.'); return []; }
  const kr = stocks.filter((s) => KR_MARKETS[s.market]);
  const codes = await corpCodes(kr.map((s) => s.code));
  const end = new Date(), start = new Date(end.getTime() - days * 86400000);
  const out = [];
  for (const s of kr) {
    const cc = codes[s.code];
    if (!cc) { log(`고유번호 없음: ${s.name}`); continue; }
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_KEY}&corp_code=${cc}&bgn_de=${ymd(start)}&end_de=${ymd(end)}&page_count=20`;
    try {
      const j = JSON.parse(await fetchText(url));
      for (const d of j.list || []) {
        out.push({
          code: s.code, name: s.name, title: d.report_nm.trim(),
          date: `${d.rcept_dt.slice(0, 4)}-${d.rcept_dt.slice(4, 6)}-${d.rcept_dt.slice(6, 8)}`,
          url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`,
        });
      }
    } catch (e) { log(`공시 실패(${s.name}):`, e.message); }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- 샘플(가짜) 데이터 ----------

function fakeBars(seed, startPrice, drift) {
  let x = seed, p = startPrice;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const bars = [];
  const d = new Date('2024-09-02');
  while (bars.length < 520) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const r = (rand() - 0.5) * 0.05 + drift;
    const open = p; p = Math.max(1, p * (1 + r));
    bars.push({
      date: d.toISOString().slice(0, 10), open,
      high: Math.max(open, p) * (1 + rand() * 0.015), low: Math.min(open, p) * (1 - rand() * 0.015),
      close: p, volume: Math.round(200000 * (0.6 + rand())),
    });
  }
  return bars;
}

// ---------- 실행 ----------

async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'watchlist.json'), 'utf8'));
  const st = cfg.settings;
  const result = { updatedAt: new Date().toISOString(), sample: SAMPLE, settings: st, fx: {}, stocks: [], disclosures: [], errors: [] };

  // ----- 증권사 잔고·실현손익 (금액은 암호화해서만 저장) -----
  const F = (n) => path.join(ROOT, 'data', n);
  const holdFile = F('holdings.enc.json'), localFile = F('holdings-local.enc.json');
  const histFile = F('history.enc.json'), realFile = F('realized.enc.json');
  const pw = SAMPLE ? 'sample1234' : ENV.HOLDINGS_PASSWORD;
  const kstNow = new Date(Date.now() + 9 * 3600000);
  const today = kstNow.toISOString().slice(0, 10);
  const readEnc = async (file, fallback) => {
    try { return decryptJSON(JSON.parse(await fs.readFile(file, 'utf8')), pw); }
    catch (e) { if (e.code !== 'ENOENT') result.errors.push(`${path.basename(file)} 해독 실패(비밀번호 변경?) → 새로 시작`); return fallback; }
  };
  let holdings = [], accounts = [];
  // 계좌 별칭 (config/accounts.json). KIS#n 은 n번째 한국투자증권 계좌
  const aliasCfg = (await fs.readFile(path.join(ROOT, 'config', 'accounts.json'), 'utf8').then(JSON.parse).catch(() => ({}))).aliases || {};
  const aliases = {};
  for (const [k, v] of Object.entries(aliasCfg)) if (!k.startsWith('KIS#')) aliases[k] = v;
  let history = pw ? await readEnc(histFile, { days: [] }) : { days: [] };
  let realized = pw ? await readEnc(realFile, { rows: [], sources: {} }) : { rows: [], sources: {} };
  const mergeRealized = (src) => {
    const key = `${src.broker}|${src.account}`;
    realized.rows = realized.rows.filter((r) => !(`${r.broker}|${r.account}` === key && r.date >= src.from && r.date <= src.to)).concat(src.rows);
    const st = realized.sources[key] || {};
    realized.sources[key] = { from: st.from && st.from < src.from ? st.from : src.from, to: src.to, updatedAt: result.updatedAt };
  };

  if (SAMPLE) {
    holdings = [
      { broker: '키움', account: '키움 계좌 1', code: '083650', name: '비에이치아이', market: 'KRX', currency: 'KRW', qty: 120, avg: 38500 },
      { broker: '키움', account: '키움 계좌 1', code: '062040', name: '산일전기', market: 'KRX', currency: 'KRW', qty: 15, avg: 88000 },
      { broker: 'KIS', account: '****5678-01', code: '006260', name: 'LS', market: 'KRX', currency: 'KRW', qty: 10, avg: 131000 },
      { broker: 'KIS', account: '****5678-01', code: 'IREN', name: 'IREN', market: 'NASDAQ', currency: 'USD', qty: 40, avg: 41.2 },
    ];
    holdings.push(
      { broker: '토스', account: '토스 계좌 1', code: '005930', name: '삼성전자', market: 'KRX', currency: 'KRW', qty: 3.42, avg: 61000, self: true, price: 199500, rawValue: 682290, rawCost: 208620, dailyRate: 5.06 },
      { broker: '토스', account: '토스 계좌 1', code: 'AAPL', name: '애플', market: 'US', currency: 'USD', qty: 0.8123, avg: 190.5, self: true, price: 268.2, rawValue: { krw: 301700, usd: 217.86 }, rawCost: { krw: 214300, usd: 154.74 }, dailyRate: -0.8 });
    accounts = [{ broker: '키움', account: '키움 계좌 1', cash: 1250000, total: null }, { broker: 'KIS', account: '****5678-01', cash: 830000, total: null }, { broker: '토스', account: '토스 계좌 1', cash: 12000, total: null }];
    Object.assign(aliases, { 'KIS|****5678-01': '한투1', '키움|키움 계좌 1': '키움(미국)', '토스|토스 계좌 1': '토스' });
    // 샘플용 과거 기록·실현손익
    let v = 9000000;
    history.days = [];
    for (let i = 180; i >= 1; i--) {
      const d = new Date(kstNow.getTime() - i * 86400000); const w = d.getUTCDay();
      if (w === 0 || w === 6) continue;
      v *= 1 + (Math.sin(i / 9) * 0.012 + (i % 7 - 3) * 0.002);
      const pA = Math.round(v * 0.4 / 100), pB = Math.round(v * 0.6 / 100);
      const cashB = 1250000 + (i < 60 ? 1000000 : 0) - (i < 20 ? 300000 : 0);   // 60일 전 100만 입금, 20일 전 30만 출금
      const A = { stockValue: pA * 100, cost: 3800000, cash: 830000, pos: { '006260': [100, pA] } };
      const Bk = { stockValue: pB * 100, cost: 5700000, cash: cashB, pos: { '083650': [100, pB] } };
      A.total = A.stockValue + A.cash; Bk.total = Bk.stockValue + Bk.cash;
      history.days.push({ date: d.toISOString().slice(0, 10), stockValue: A.stockValue + Bk.stockValue, cost: 9500000, cash: A.cash + Bk.cash, total: A.total + Bk.total,
        byAccount: { 'KIS|****5678-01': A, '키움|키움 계좌 1': Bk } });
    }
    const names = [['005930', '삼성전자'], ['000660', 'SK하이닉스'], ['083650', '비에이치아이'], ['012450', '한화에어로스페이스'], ['267260', 'HD현대일렉트릭']];
    realized = { rows: [], sources: { '키움|키움 계좌 1': { from: '2025-11-10' }, 'KIS|****5678-01': { from: '2025-11-10' } } };
    for (let i = 0; i < 40; i++) {
      const d = new Date(kstNow.getTime() - (i * 9 + 2) * 86400000); if ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 2);
      const [code, name] = names[i % names.length]; const qty = 5 + (i % 4) * 5; const amt = qty * (30000 + i * 1700);
      const rate = Math.round((Math.sin(i * 1.7) * 14 + 2) * 100) / 100; const pl = Math.round(amt * rate / (100 + rate));
      realized.rows.push({ date: d.toISOString().slice(0, 10), broker: i % 3 ? 'KIS' : '키움', account: i % 3 ? '****5678-01' : '키움 계좌 1', code, name, qty, sellAmt: amt, buyPrice: Math.round((amt - pl) / qty), pl, rate, fee: Math.round(amt * 0.00015), tax: Math.round(amt * 0.0018) });
    }
  } else if (pw) {
    // 한국투자증권 계좌가 여러 개면 KIS_APPKEY_2 / KIS_APPSECRET_2 / KIS_ACCOUNT_2 … 로 추가
    for (const [i, sfx] of ['', '_2', '_3'].entries()) {
      const appkey = ENV['KIS_APPKEY' + sfx], appsecret = ENV['KIS_APPSECRET' + sfx], account = ENV['KIS_ACCOUNT' + sfx];
      if (!appkey || !appsecret || !account) continue;
      const kcfg = { appkey, appsecret, account };
      try {
        const k = await fetchKIS(kcfg);
        holdings.push(...k.items); accounts.push(...k.accounts);
        if (aliasCfg[`KIS#${i + 1}`]) aliases[`KIS|${k.accounts[0].account}`] = aliasCfg[`KIS#${i + 1}`];
        log(`한국투자증권 계좌 ${i + 1} 잔고 ${k.items.length}종목`);
      } catch (e) { result.errors.push(`한국투자증권 계좌 ${i + 1} 잔고: ${e.message}`); continue; }
      try {
        // 처음엔 최근 1년치를 채우고, 이후엔 최근 14일만 다시 확인
        const label = accounts.at(-1).account;
        const first = !realized.sources[`KIS|${label}`];
        const fromD = new Date(kstNow.getTime() - (first ? 365 : 14) * 86400000).toISOString().slice(0, 10);
        const r = await fetchKISRealized(kcfg, fromD.replace(/-/g, ''), today.replace(/-/g, ''));
        mergeRealized({ broker: 'KIS', account: r.account, from: fromD, to: today, rows: r.rows });
        log(`한국투자증권 계좌 ${i + 1} 실현손익 ${r.rows.length}건 (${fromD}~)`);
      } catch (e) { result.errors.push(`한국투자증권 계좌 ${i + 1} 실현손익: ${e.message}`); }
    }
    try {
      const local = decryptJSON(JSON.parse(await fs.readFile(localFile, 'utf8')), pw);
      const useLocalKIS = !ENV.KIS_APPKEY;
      holdings.push(...local.items.filter((h) => useLocalKIS || h.broker !== 'KIS'));
      accounts.push(...(local.accounts || []).filter((a) => useLocalKIS || a.broker !== 'KIS'));
      for (const src of local.realized || []) if (useLocalKIS || src.broker !== 'KIS') mergeRealized(src);
      result.localSyncAt = local.updatedAt;
      log(`PC 동기화 잔고 ${local.items.length}종목 (${local.updatedAt})`);
    } catch (e) {
      if (e.code !== 'ENOENT') result.errors.push(`PC 동기화 잔고 해독 실패(비밀번호가 같은지 확인): ${e.message}`);
    }
  }
  // 보유 종목 중 watchlist 에 없는 것은 자동으로 분석 대상에 추가 (종목명만 공개, 수량·평단은 암호화)
  // 토스(주식모으기)처럼 증권사가 현재가·평가금액을 직접 주는 종목(self)은 분석 대상에 넣지 않음
  for (const h of holdings) {
    if (h.self) continue;
    if (!cfg.stocks.some((s) => s.code === h.code)) {
      cfg.stocks.push({ name: h.name, code: h.code, market: h.market, sector: '미분류' });
    }
  }
  result.hasHoldings = holdings.length > 0;

  const bench = {};
  const benchSymbol = (m) => (KR_MARKETS[m] ? '^KS11' : '^IXIC');
  if (SAMPLE) {
    bench['^KS11'] = fakeBars(7, 2600, 0.0006).map((b) => b.close);
    bench['^IXIC'] = fakeBars(11, 17000, 0.0007).map((b) => b.close);
    result.fx.USDKRW = 1385;
  } else {
    for (const sym of ['^KS11', '^IXIC']) {
      try { bench[sym] = (await fromYahoo(sym)).map((b) => b.close); }
      catch (e) { result.errors.push(`지수 ${sym}: ${e.message}`); }
    }
    try { result.fx.USDKRW = round((await fromYahoo('KRW=X')).at(-1).close, 1); }
    catch (e) { result.errors.push(`환율: ${e.message}`); }
  }

  const fakeSpec = [[3, 18000, 0.0028], [5, 120000, 0.0006], [9, 90000, 0.0002], [13, 30000, 0.0009], [17, 9, 0.002]];
  for (const [i, s] of cfg.stocks.entries()) {
    try {
      const bars = SAMPLE ? fakeBars(...(fakeSpec[i % fakeSpec.length])) : await getBars(s);
      if (SAMPLE && i === 0) { const b = bars.at(-1); b.close *= 1.09; b.high = b.close * 1.01; b.volume *= 3; }
      result.stocks.push({ ...s, currency: KR_MARKETS[s.market] ? 'KRW' : 'USD', ...analyze(bars, st, bench[benchSymbol(s.market)]) });
      log(`완료: ${s.name}`);
    } catch (e) {
      result.errors.push(`${s.name}: ${e.message}`);
      log(`실패: ${s.name}`, e.message);
    }
  }

  if (SAMPLE) {
    result.disclosures = [
      { code: '083650', name: '비에이치아이', title: '[샘플] 단일판매ㆍ공급계약체결', date: '2026-11-05', url: 'https://dart.fss.or.kr' },
      { code: '062040', name: '산일전기', title: '[샘플] 분기보고서', date: '2026-11-03', url: 'https://dart.fss.or.kr' },
    ];
  } else {
    try { result.disclosures = await disclosures(cfg.stocks, st.disclosureDays); }
    catch (e) { result.errors.push(`공시: ${e.message}`); }
  }

  await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
  // self 종목 원화 환산 (평가금액·매입금액)
  {
    const fx = result.fx.USDKRW || 0;
    const krw = (raw, cur, fallback) => (raw && typeof raw === 'object' ? (raw.krw ?? (raw.usd != null ? raw.usd * fx : null)) : raw != null ? (cur === 'USD' ? raw * fx : raw) : fallback);
    for (const h of holdings) if (h.self) {
      h.valueKrw = Math.round(krw(h.rawValue, h.currency, h.price * h.qty * (h.currency === 'USD' ? fx : 1)));
      h.costKrw = Math.round(krw(h.rawCost, h.currency, h.avg * h.qty * (h.currency === 'USD' ? fx : 1)));
    }
  }
  if (pw && (holdings.length || realized.rows.length)) {
    await fs.writeFile(holdFile, JSON.stringify(encryptJSON({ updatedAt: result.updatedAt, sample: SAMPLE, items: holdings, accounts, aliases }, pw)));

    // 일별 잔고 기록: 평일에만, 같은 날 여러 번 돌면 마지막 값으로 덮어씀
    const wd = kstNow.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const px = Object.fromEntries(result.stocks.map((s) => [s.code, s]));
      const fx = result.fx.USDKRW || 0;
      const byStock = {};
      let stockValue = 0, cost = 0;
      for (const h of holdings) {
        const s = px[h.code]; if (!s && !h.self) continue;
        const k = h.currency === 'USD' ? fx : 1;
        const v = s ? s.close * h.qty * k : h.valueKrw, c = s ? h.avg * h.qty * k : h.costKrw;
        stockValue += v; cost += c;
        const o = byStock[h.code] ||= { name: h.name, v: 0, c: 0 };  // self 종목 포함
        o.v += v; o.c += c;
      }
      // 계좌별 합계 (키: "증권사|계좌")
      const byAccount = {};
      for (const h of holdings) {
        const s = px[h.code]; if (!s && !h.self) continue;
        const k = h.currency === 'USD' ? fx : 1;
        const o = byAccount[`${h.broker}|${h.account || h.broker}`] ||= { stockValue: 0, cost: 0, cash: null, pos: {} };
        o.stockValue += s ? s.close * h.qty * k : h.valueKrw; o.cost += s ? h.avg * h.qty * k : h.costKrw;
        // 입출금 추정용: 종목별 [수량, 원화 환산 종가]
        const ps = (o.pos ||= {})[h.code] || [0, 0];
        o.pos[h.code] = [ps[0] + h.qty, Math.round((s ? s.close * k : h.valueKrw / h.qty) * 100) / 100];
      }
      for (const a of accounts) {
        const o = byAccount[`${a.broker}|${a.account}`] ||= { stockValue: 0, cost: 0, cash: null, pos: {} };
        if (a.cash != null) o.cash = (o.cash || 0) + a.cash;
      }
      for (const o of Object.values(byAccount)) {
        o.stockValue = Math.round(o.stockValue); o.cost = Math.round(o.cost);
        o.cash = o.cash == null ? null : Math.round(o.cash); o.total = o.stockValue + (o.cash || 0);
      }
      const cashKnown = accounts.some((a) => a.cash != null);
      const cash = accounts.reduce((t, a) => t + (a.cash || 0), 0);
      const day = { date: today, stockValue: Math.round(stockValue), cost: Math.round(cost), cash: cashKnown ? Math.round(cash) : null,
        total: Math.round(stockValue + (cashKnown ? cash : 0)), fx,
        byStock: Object.fromEntries(Object.entries(byStock).map(([k, o]) => [k, { name: o.name, v: Math.round(o.v), c: Math.round(o.c) }])), byAccount };
      history.days = history.days.filter((d) => d.date !== today).concat(day).sort((x, y) => x.date.localeCompare(y.date));
    }
    await fs.writeFile(histFile, JSON.stringify(encryptJSON({ updatedAt: result.updatedAt, sample: SAMPLE, ...history, aliases }, pw)));
    realized.rows.sort((x, y) => y.date.localeCompare(x.date));
    await fs.writeFile(realFile, JSON.stringify(encryptJSON({ updatedAt: result.updatedAt, sample: SAMPLE, ...realized }, pw)));
  } else if (!pw) {
    for (const f of [holdFile, histFile, realFile]) await fs.rm(f, { force: true });
  }
  await fs.writeFile(path.join(ROOT, 'data', 'summary.json'), JSON.stringify(result));
  log(`저장 완료 · 종목 ${result.stocks.length}개 · 공시 ${result.disclosures.length}건 · 오류 ${result.errors.length}건`);
  if (!result.stocks.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
