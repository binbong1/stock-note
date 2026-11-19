// 급등주 정리 — 코스피·코스닥에서 전일 대비 N% 이상 오른 개별 종목(ETF·ETN·스팩 제외)을 텔레그램으로
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

async function gainers(market, minPct) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await getJSON(`https://m.stock.naver.com/api/stocks/up/${market}?page=${page}&pageSize=100`);
    const list = j.stocks || [];
    for (const s of list) {
      const pct = parseFloat(s.fluctuationsRatio);
      if (!(pct >= minPct)) return out;
      if (s.stockEndType !== 'stock' || /스팩|SPAC|ETN|ETF/i.test(s.stockName)) continue;
      out.push({ code: s.itemCode, name: s.stockName, market: market === 'KOSPI' ? '코스피' : '코스닥', pct, upper: s.compareToPreviousPrice?.name === 'UPPER_LIMIT',
        price: s.closePrice, cap: s.marketValueHangeul, value: s.accumulatedTradingValueKrwHangeul, tradedAt: s.localTradedAt, status: s.marketStatus });
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
    const pick = todays.find((n) => /특징주|급등|상한가|강세/.test(n.title)) || todays[0];
    if (!pick) return null;
    return { title: unesc(pick.titleFull || pick.title), url: pick.mobileNewsUrl, office: pick.officeName };
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

  for (const s of all) s.why = await reason(s);
  const lines = [`<b>🚀 급등주 정리</b> (${today().slice(5).replace('-', '/')} ${hm} 기준 · ${minPct}% 이상)`];
  if (!all.length) lines.push('', `${minPct}% 이상 오른 종목이 없어요.`);
  else {
    lines.push(`코스피 ${kospi.length} · 코스닥 ${kosdaq.length}종목`, '');
    for (const s of all) {
      lines.push(`<b>${esc(s.name)}</b> ${s.market} <b>+${s.pct.toFixed(2)}%</b>${s.upper ? ' 상한가' : ''} · ${esc(s.price)}원`);
      lines.push(`  시총 ${esc(s.cap)} · 거래대금 ${esc(s.value)}`);
      lines.push(s.why ? `  └ ${esc(s.why.title)} (<a href="${esc(s.why.url)}">${esc(s.why.office)}</a>)` : '  └ 뚜렷한 재료 확인 안 됨');
    }
  }
  lines.push('', '<i>시세는 조회 시점 기준이며 지연될 수 있어요 · 자료: 네이버 증권</i>');
  const text = lines.join('\n');
  if (PRINT) { console.log(text.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2 $1').replace(/<[^>]+>/g, '')); return; }
  await send(text);
  console.log(`[surge] ${all.length}종목 보냈어요`);
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
