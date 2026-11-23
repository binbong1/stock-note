// 급등주 정리 — 코스피·코스닥에서 전일 대비 N% 이상 오른 개별 종목 + 오늘 52주 신고가 종목(ETF·ETN·스팩 제외)을 텔레그램으로
//   node scripts/surge.mjs           텔레그램으로 보내기 (평일 10:30·15:00, local/run.mjs 가 실행)
//   node scripts/surge.mjs --print   보내지 않고 화면에만 출력 (Claude가 "지금 급등주" 요청에 사용)
// 상승 이유는 그 종목의 오늘 뉴스 제목(특징주 기사 우선)으로 적어요. 매수·매도 추천은 하지 않아요.
// 기준값: config/alerts.json 의 surge.minPct (기본 25), 끄기: surge.enabled=false

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env;
const PRINT = process.argv.includes('--print');
const H = { 'User-Agent': 'Mozilla/5.0' };
const kst = () => new Date(Date.now() + 9 * 3600000);
const today = () => kst().toISOString().slice(0, 10);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const getJSON = async (u) => { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`); return r.json(); };

const isStock = (s) => s.stockEndType === 'stock' && !/스팩|SPAC|ETN|ETF|클래스/i.test(s.stockName);
const capText = (raw, fallback) => { const v = Number(raw); if (!v) return String(fallback || '').replace(/원$/, '');
  return v >= 1e12 ? `${(v / 1e12).toFixed(1)}조` : `${Math.round(v / 1e8).toLocaleString('ko-KR')}억`; };
const item = (s, market) => ({ code: s.itemCode, name: s.stockName, market: market === 'KOSPI' ? '코스피' : '코스닥', pct: parseFloat(s.fluctuationsRatio),
  upper: s.compareToPreviousPrice?.name === 'UPPER_LIMIT', price: s.closePrice, cap: capText(s.marketValueRaw, s.marketValueHangeul),
  value: String(s.accumulatedTradingValueKrwHangeul || '').replace(/원$/, '') });

// 오늘 52주 신고가 (네이버 증권 52주 신고가 목록)
async function newHighs(market) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await getJSON(`https://m.stock.naver.com/api/stocks/high52week/${market}?page=${page}&pageSize=100`);
    const list = j.stocks || [];
    for (const s of list) if (isStock(s)) out.push(item(s, market));
    if (list.length < 100) break;
  }
  return out;
}

async function gainers(market, minPct) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await getJSON(`https://m.stock.naver.com/api/stocks/up/${market}?page=${page}&pageSize=100`);
    const list = j.stocks || [];
    for (const s of list) {
      const pct = parseFloat(s.fluctuationsRatio);
      if (!(pct >= minPct)) return out;
      if (!isStock(s)) continue;
      out.push(item(s, market));
    }
    if (list.length < 100) break;
  }
  return out;
}

async function reason(s) {
  try {
    const j = await getJSON(`https://m.stock.naver.com/api/news/stock/${s.code}?pageSize=8&page=1`);
    const items = j.flatMap((g) => g.items || []);
    const ymd = today().replace(/-/g, '');
    const todays = items.filter((n) => String(n.datetime || '').startsWith(ymd));
    // 오늘 뉴스 우선(특징주 기사 먼저), 없으면 최근 3일 안 가장 새 기사에 날짜를 붙여요
    const since = new Date(Date.now() + 9 * 3600000 - 3 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const pick = todays.find((n) => /특징주|급등|상한가|강세|신고가/.test(n.title)) || todays[0] || items.find((n) => String(n.datetime || '').slice(0, 8) >= since);
    if (!pick) return null;
    const d = String(pick.datetime || '');
    return { title: unesc(pick.titleFull || pick.title), url: pick.mobileNewsUrl, office: pick.officeName, day: d.startsWith(ymd) ? '' : `${+d.slice(4, 6)}/${+d.slice(6, 8)}` };
  } catch { return null; }
}

async function main() {
  const alerts = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'alerts.json'), 'utf8').catch(() => '{}'));
  const cfg = alerts.surge || {};
  if (cfg.enabled === false && !PRINT) { console.log('[surge] 급등주 알림이 꺼져 있어요'); return; }
  const minPct = cfg.minPct || 25;
  const [kospi, kosdaq] = await Promise.all([gainers('KOSPI', minPct), gainers('KOSDAQ', minPct)]);
  const all = [...kospi, ...kosdaq].sort((a, b) => b.pct - a.pct);
  const hm = kst().toISOString().slice(11, 16);

  // 휴장일: 오늘 거래된 자료가 아니면 (네이버 상승률 목록의 거래 시각으로 판단)
  const probe = await getJSON('https://m.stock.naver.com/api/stocks/up/KOSPI?page=1&pageSize=1').catch(() => null);
  const tradedDay = probe?.stocks?.[0]?.localTradedAt?.slice(0, 10);
  if (tradedDay && tradedDay !== today()) {
    const msg = '📅 오늘은 휴장일이에요. 급등주 정리는 쉬어요.';
    if (PRINT) { console.log(msg); return; }
    if (hm < '11:00') await send(msg); // 하루 한 번만
    return;
  }

  const highs = [...(await newHighs('KOSPI').catch(() => [])), ...(await newHighs('KOSDAQ').catch(() => []))].sort((x, y) => y.pct - x.pct);
  const highCodes = new Set(highs.map((h) => h.code));
  const highOnly = highs.filter((h) => !all.some((g) => g.code === h.code));
  const MAX_HIGH = 30;
  for (const s of [...all, ...highOnly.slice(0, MAX_HIGH)]) s.why = await reason(s);

  const LINE = '━━━━━━━━━━━━━━';
  const pct = (p) => `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
  const news = (s) => s.why ? `📰 ${s.why.day ? `<i>(${s.why.day})</i> ` : ''}<a href="${esc(s.why.url)}">${esc(s.why.title)}</a>` : '📰 <i>최근 뉴스 없음</i>';
  const lines = [`<b>🚀 급등주 · 신고가</b>  ${today().slice(5).replace('-', '/')} ${hm}`, LINE];
  lines.push(`<b>🔥 급등 ${minPct}%↑</b>  ${all.length}종목`, '');
  if (!all.length) lines.push(`${minPct}% 이상 오른 종목이 없어요.`, '');
  all.forEach((s, i) => {
    lines.push(`<b>${i + 1}. ${esc(s.name)}  ${pct(s.pct)}</b>${s.upper ? ' 🔺상한가' : ''}${highCodes.has(s.code) ? ' 🏔신고가' : ''}`);
    lines.push(`${s.market} · ${esc(s.price)}원 · 시총 ${esc(s.cap)} · 대금 ${esc(s.value)}`);
    lines.push(news(s), '');
  });
  lines.push(LINE, `<b>🏔 52주 신고가</b>  ${highs.length}종목${highs.length > highOnly.length ? ` (급등주 ${highs.length - highOnly.length}개 포함)` : ''}`, '');
  if (!highOnly.length) lines.push(highs.length ? '위 급등주 외에는 없어요.' : '오늘 신고가 종목이 없어요.', '');
  highOnly.slice(0, MAX_HIGH).forEach((s) => {
    lines.push(`<b>${esc(s.name)}  ${pct(s.pct)}</b>`);
    lines.push(`${s.market} · ${esc(s.price)}원 · 시총 ${esc(s.cap)}`);
    lines.push(news(s), '');
  });
  if (highOnly.length > MAX_HIGH) lines.push(`외 ${highOnly.length - MAX_HIGH}종목: ${highOnly.slice(MAX_HIGH).map((s) => esc(s.name)).join(', ')}`, '');
  lines.push('<i>조회 시점 시세 · ETF·ETN·스팩 제외 · 자료: 네이버 증권</i>');
  const text = lines.join('\n');
  if (PRINT) { console.log(text.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2 $1').replace(/<[^>]+>/g, '')); return; }
  await send(text);
  console.log(`[surge] 급등 ${all.length} · 신고가 ${highs.length}종목 보냈어요`);
}

async function send(text) {
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) { console.log('[surge] 텔레그램 설정 없음'); return; }
  // 텔레그램 한 번에 4096자 → 줄 단위로 나눠 보냄
  const chunks = []; let cur = '';
  for (const line of text.split('\n')) { if ((cur + '\n' + line).length > 3800) { chunks.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line; }
  if (cur) chunks.push(cur);
  for (const c of chunks) {
    const r = await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text: c, parse_mode: 'HTML', disable_web_page_preview: true }) });
    if (!r.ok) throw new Error(`텔레그램 전송 실패 ${r.status} ${(await r.text()).slice(0, 150)}`);
  }
}

main().catch((e) => { console.error('[surge] 실패:', e.message); process.exit(1); });
