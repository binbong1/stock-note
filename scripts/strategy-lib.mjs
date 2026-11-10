// 추세추종 공통 로직 (GitHub 스캐너와 맥북 봇이 함께 사용)
// 외부 패키지 없음

export const UA = { 'User-Agent': 'Mozilla/5.0 (stock-note personal scanner)' };
export const kstNow = () => new Date((process.env.SCAN_NOW ? Date.parse(process.env.SCAN_NOW) : Date.now()) + 9 * 3600000); // SCAN_NOW: 테스트용 시각(UTC)
export const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
export const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 데이터
export async function fetchText(url, enc) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  if (!enc) return res.text();
  return new TextDecoder(enc).decode(await res.arrayBuffer());
}

export async function dailyBars(code, days = 430) {
  const end = kstNow(), start = new Date(end.getTime() - days * 86400000);
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${ymd(start)}&endTime=${ymd(end)}&timeframe=day`;
  const text = (await fetchText(url)).trim().replace(/'/g, '"').replace(/,\s*\]/g, ']');
  return JSON.parse(text).slice(1).filter((r) => r && r[4] != null).map((r) => ({
    date: `${String(r[0]).slice(0, 4)}-${String(r[0]).slice(4, 6)}-${String(r[0]).slice(6, 8)}`,
    open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  }));
}

// ------------------------------------------------------------------ 지표
export const sma = (arr, n, end = arr.length) => (end < n ? null : arr.slice(end - n, end).reduce((a, b) => a + b, 0) / n);
export const maxOf = (arr) => arr.reduce((a, b) => (b > a ? b : a), -Infinity);
export const minOf = (arr) => arr.reduce((a, b) => (b < a ? b : a), Infinity);
export const ret = (c, back) => (c.length > back ? c.at(-1) / c.at(-1 - back) - 1 : null);

// 1 Stage 조건: 정배열 + 52주 고가 근처 (이미지의 '52주 신고가 갱신(정배열 선호)')
export function trendTemplate(b, cfg) {
  const c = b.map((x) => x.close), n = c.length;
  if (n < 220) return null;
  const ma20 = sma(c, 20), ma50 = sma(c, 50), ma150 = sma(c, 150), ma200 = sma(c, 200), ma200p = sma(c, 200, n - 20);
  const last = b.slice(-250);
  const high52 = maxOf(last.map((x) => x.high)), low52 = minOf(last.map((x) => x.low));
  const close = c.at(-1);
  const aligned = close > ma50 && ma50 > ma150 && ma150 > ma200 && ma200 > ma200p;
  const ok = (!cfg.trend.requireAligned || aligned)
    && close >= high52 * (1 - cfg.trend.maxBelow52wHighPct / 100)
    && close >= low52 * (1 + cfg.trend.minAbove52wLowPct / 100);
  const recentHighIdx = last.length - 1 - [...last].reverse().findIndex((x) => x.high === high52);
  return { ok, aligned, ma20, ma50, ma150, ma200, high52, low52, daysSince52wHigh: last.length - 1 - recentHighIdx };
}

// 2 Stage: 52주 고가(피벗) 이후 1~6주 조정, 조정폭 ≤ 직전 상승폭의 절반, 변동성·거래량 수축(VCP)
export function baseInfo(b, cfg) {
  const B = cfg.base, n = b.length;
  if (n < 160) return null;
  const from = n - 1 - B.maxDays;
  let p = from;
  for (let i = from; i < n; i++) if (b[i].high >= b[p].high) p = i;
  const days = n - 1 - p;
  const pivot = b[p].high;
  const priorLow = minOf(b.slice(Math.max(0, p - 120), p + 1).map((x) => x.low));
  const advancePct = (pivot / priorLow - 1) * 100;
  const after = b.slice(p + 1);
  const baseLow = after.length ? minOf(after.map((x) => x.low)) : pivot;
  const depthPct = (1 - baseLow / pivot) * 100;
  const high52before = maxOf(b.slice(Math.max(0, p - 250), p + 1).map((x) => x.high));
  const v = b.map((x) => x.volume);
  const avgVol50 = sma(v, 50) || 0;
  const last5 = b.slice(-5);
  const tightPct = (maxOf(last5.map((x) => x.high)) / minOf(last5.map((x) => x.low)) - 1) * 100;
  const volDry = (sma(v, 5) || 0) < B.volumeDryRatio * avgVol50;
  const ok = days >= B.minDays && days <= B.maxDays
    && advancePct >= B.minPriorAdvancePct
    && depthPct <= B.maxDepthPct
    && (pivot - baseLow) <= B.maxDepthOfAdvance * (pivot - priorLow)
    && pivot >= high52before * (1 - B.pivotNear52wHighPct / 100);
  return { ok, pivot, pivotDate: b[p].date, days, priorLow, advancePct: r2(advancePct), baseLow, depthPct: r2(depthPct),
    tight: tightPct <= B.tightRangePct, tightPct: r2(tightPct), volDry, avgVol50: Math.round(avgVol50) };
}

export function riskPlan(entry, base, cfg, totalAsset) {
  const R = cfg.risk;
  const swingLow = base.recentLow ?? base.baseLow;
  const stop = Math.max(entry * (1 - R.maxStopPct / 100), Math.min(swingLow, entry * 0.98));
  const risk = entry - stop;
  const target = entry + R.rewardRisk * risk;
  const plan = { stop: Math.round(stop), stopPct: r2((stop / entry - 1) * 100), target: Math.round(target), targetPct: r2((target / entry - 1) * 100) };
  if (totalAsset && risk > 0) {
    const shares = Math.floor((totalAsset * R.riskPerTradePct / 100) / risk);
    plan.shares = Math.max(0, Math.min(shares, Math.floor(totalAsset / entry)));
    plan.amount = Math.round(plan.shares * entry);
  }
  return plan;
}


// RS: 3·6·9·12개월 가중 수익률
export function weightedReturn(closes) {
  const w = [ret(closes, 63), ret(closes, 126), ret(closes, 189), ret(closes, 249)];
  return w.some((v) => v == null) ? null : 0.4 * w[0] + 0.2 * w[1] + 0.2 * w[2] + 0.2 * w[3];
}
// 스캔 때 저장한 분위 경계(rsCut, 99개)로 아무 종목의 RS 등급(1~99) 계산
export function rsFromCut(raw, cut) {
  if (raw == null || !cut?.length) return null;
  let i = 0; while (i < cut.length && raw > cut[i]) i++;
  return Math.max(1, Math.min(99, Math.round(i / cut.length * 99)));
}

// 종목 하나를 Stage 기준으로 판정 (봇의 '분석' 명령용)
export function classify(bars, cfg, rs) {
  const today = bars.at(-1);
  const t = trendTemplate(bars, cfg);
  if (!t) return { stage: '데이터 부족', today };
  const prevB = bars.slice(0, -1), prevBase = baseInfo(prevB, cfg), prevTrend = trendTemplate(prevB, cfg);
  const base = baseInfo(bars, cfg);
  const rsOk = rs == null || rs >= cfg.minRS;
  let stage = '추세 아님', pivot = null, detail = base;
  if (t.ok && rsOk && prevBase?.ok && prevTrend?.ok && today.close > prevBase.pivot) {
    const volRatio = prevBase.avgVol50 ? today.volume / prevBase.avgVol50 : 0;
    const ext = (today.close / prevBase.pivot - 1) * 100;
    if (volRatio >= cfg.breakout.volumeRatio && ext <= cfg.breakout.maxExtendedPct) { stage = '3 Stage (돌파)'; pivot = prevBase.pivot; detail = { ...prevBase, volRatio: r2(volRatio) }; }
  }
  if (stage === '추세 아님' && t.ok && rsOk && base?.ok && today.close <= base.pivot) { stage = '2 Stage (베이스)'; pivot = base.pivot; }
  else if (stage === '추세 아님' && t.ok && rsOk) stage = '1 Stage (추세)';
  else if (stage === '추세 아님' && t.ok && !rsOk) stage = '정배열이지만 RS 부족';
  const recentLow = minOf(bars.slice(-10).map((x) => x.low));
  return { stage, today, trend: t, base: detail ? { ...detail, recentLow } : null, pivot };
}
