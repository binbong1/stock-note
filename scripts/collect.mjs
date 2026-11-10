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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.argv.includes('--sample');
const DART_KEY = process.env.DART_API_KEY || '';
const UA = { 'User-Agent': 'Mozilla/5.0 (stock-note personal dashboard)' };
const KR_MARKETS = { KOSPI: '.KS', KOSDAQ: '.KQ' };

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
    return fromYahoo(stock.code + KR_MARKETS[stock.market]);
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
  if (stockCodes.every((c) => cache[c])) return cache;
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_KEY}`, { headers: UA });
  if (!res.ok) throw new Error(`DART corpCode HTTP ${res.status}`);
  const xml = unzipFirst(Buffer.from(await res.arrayBuffer())).toString('utf8');
  const re = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>[^<]*<\/corp_name>\s*(?:<corp_eng_name>[^<]*<\/corp_eng_name>\s*)?<stock_code>\s*(\d{6})\s*<\/stock_code>/g;
  for (const m of xml.matchAll(re)) if (stockCodes.includes(m[2])) cache[m[2]] = m[1];
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
  await fs.writeFile(path.join(ROOT, 'data', 'summary.json'), JSON.stringify(result));
  log(`저장 완료 · 종목 ${result.stocks.length}개 · 공시 ${result.disclosures.length}건 · 오류 ${result.errors.length}건`);
  if (!result.stocks.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
