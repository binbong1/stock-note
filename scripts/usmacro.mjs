// 미국 지표 3종 → 최근 3년 그래프 3장을 텔레그램으로 보냅니다 (미국 장 마감 뒤).
//   ① 회사채 스프레드: 하이일드(BAMLH0A0HYM2)·투자등급(BAMLC0A0CM) OAS + 나스닥 종합지수(NASDAQCOM)  ② 미국 10년물 국채금리(DGS10)  ③ WTI 유가(DCOILWTICO)
//   node scripts/usmacro.mjs          새 기준일 자료가 나왔으면 보냄 (이미 보낸 날짜면 건너뜀)
//   node scripts/usmacro.mjs --force  다시 보냄
//   node scripts/usmacro.mjs --print [--png 폴더]  보내지 않고 요약만 출력 (폴더를 주면 그래프 3장도 저장)
// 자료: FRED (세인트루이스 연준). 보통 미국 전 거래일 기준이고, WTI 현물은 며칠 늦게 올라와요.
// 그래프 이미지는 quickchart.io 로 만들어요 (공개 시장 자료만 보냄). quickchart 무료는 선 하나에 점 250개 정도가 한계라 그래프는 주간(금요일) 값으로 그려요.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env;
const FILE = path.join(ROOT, 'data', 'usmacro.json');
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const PRINT = argv.includes('--print');
const PNG_DIR = argv.includes('--png') ? argv[argv.indexOf('--png') + 1] : null;
const log = (...a) => console.log('[usmacro]', ...a);
const SERIES = { hy: 'BAMLH0A0HYM2', ig: 'BAMLC0A0CM', nasdaq: 'NASDAQCOM', t10: 'DGS10', wti: 'DCOILWTICO' };

async function fetchFred(id, from) {
  const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}`, { signal: AbortSignal.timeout(40000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`FRED ${id} HTTP ${r.status}`);
  return (await r.text()).trim().split(/\r?\n/).slice(1)
    .map((l) => { const [date, v] = l.split(','); return { date, v: v === '' || v === '.' ? NaN : Number(v) }; })
    .filter((x) => /^\d{4}-\d\d-\d\d$/.test(x.date) && Number.isFinite(x.v))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const ago = (rows, days) => { const t = new Date(Date.parse(rows.at(-1).date) - days * 86400000).toISOString().slice(0, 10); return rows.find((r) => r.date >= t) || rows[0]; };
const ext = (rows, fn) => rows.reduce((a, r) => (fn(r.v, a.v) ? r : a));
// 주 단위(그 주 마지막 거래일)로 줄임 + 맨 끝 값은 항상 포함
function weekly(rows) {
  const out = new Map();
  for (const r of rows) { const d = new Date(r.date + 'T00:00:00Z'); const mon = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); out.set(mon, r); }
  return [...out.values()];
}
const bp = (d) => { const v = Math.round(d * 100); return (v > 0 ? '+' : v < 0 ? '-' : '±') + Math.abs(v) + 'bp'; };
const sgnPct = (a, b) => { const v = (a / b - 1) * 100; return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; };
const md = (d) => d.slice(2).replace(/-/g, '/');

async function quickchart(cfg) {
  const r = await fetch('https://quickchart.io/chart', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ version: '4', width: 900, height: 500, devicePixelRatio: 2, backgroundColor: 'white', format: 'png', chart: cfg }),
  });
  if (!r.ok) throw new Error(`그래프 만들기 실패 HTTP ${r.status} ${r.headers.get('x-quickchart-error') || ''}`);
  return Buffer.from(await r.arrayBuffer());
}
const lineDs = (label, rows, color, axis, fill) => ({ label, data: rows.map((r) => r.v), borderColor: color, backgroundColor: fill ? color + '14' : undefined, fill: !!fill, pointRadius: 0, borderWidth: 2, yAxisID: axis });
const titleOpt = (text) => ({ title: { display: true, text, font: { size: 16 } }, legend: { position: 'bottom' } });

// date 이하에서 가장 최근 값 (나스닥은 스프레드보다 하루 늦게 올라오는 날이 있어서)
function asOfSeries(dates, rows) {
  let i = 0, cur = null;
  return dates.map((date) => { while (i < rows.length && rows[i].date <= date) cur = rows[i++].v; return { date, v: cur }; });
}
function spreadChart(hy, ig, nq) {
  const w = weekly(hy), dates = w.map((r) => r.date);
  const igW = asOfSeries(dates, ig), nqW = asOfSeries(dates, nq);
  return quickchart({
    type: 'line',
    data: { labels: w.map((r) => md(r.date)), datasets: [lineDs('하이일드 스프레드', w, '#d9480f', 'y', true), { ...lineDs('투자등급 스프레드', igW, '#1c7ed6', 'y1'), spanGaps: true }, { ...lineDs('나스닥 (흐름)', nqW, '#495057', 'y2'), borderDash: [6, 3], borderWidth: 1.5, spanGaps: true }] },
    options: { plugins: titleOpt(`① 미국 회사채 스프레드 vs 나스닥 (최근 3년, ${hy.at(-1).date} 기준)`), scales: {
      x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } },
      y: { position: 'left', title: { display: true, text: '하이일드 (%p)' }, ticks: { color: '#d9480f' } },
      y1: { position: 'right', title: { display: true, text: '투자등급 (%p)' }, ticks: { color: '#1c7ed6' }, grid: { drawOnChartArea: false } },
      y2: { display: false } } }, // 나스닥은 흐름만 (축 숫자 안 보임)
  });
}
function singleChart(rows, title, label, unit, color) {
  const w = weekly(rows);
  return quickchart({
    type: 'line',
    data: { labels: w.map((r) => md(r.date)), datasets: [lineDs(label, w, color, 'y', true)] },
    options: { plugins: titleOpt(`${title} (최근 3년, ${rows.at(-1).date} 기준)`), scales: {
      x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } },
      y: { title: { display: true, text: unit } } } },
  });
}

function caption(d, html = true) {
  const b = (s) => (html ? `<b>${s}</b>` : s);
  const rateLine = (rows, name) => {
    const l = rows.at(-1), p = rows.at(-2), hi = ext(rows, (a, c) => a > c), lo = ext(rows, (a, c) => a < c);
    return `${name} ${b(l.v.toFixed(2) + '%')} (전일 ${bp(l.v - p.v)} · 1개월 ${bp(l.v - ago(rows, 30).v)} · 1년 ${bp(l.v - ago(rows, 365).v)})\n   3년 범위 ${lo.v.toFixed(2)}~${hi.v.toFixed(2)}%`;
  };
  const w = d.wti, wl = w.at(-1), wp = w.at(-2), whi = ext(w, (a, c) => a > c), wlo = ext(w, (a, c) => a < c);
  return [
    `${b('🇺🇸 미국 지표')} (미국 ${d.hy.at(-1).date} 기준)`,
    '',
    b('① 회사채 스프레드') + ' (국채 대비 가산금리)',
    rateLine(d.hy, '하이일드'),
    rateLine(d.ig, '투자등급'),
    '',
    b('② 10년물 국채금리'),
    rateLine(d.t10, '10년물'),
    '',
    b('③ WTI 유가') + (wl.date !== d.hy.at(-1).date ? ` (${wl.date} 기준)` : ''),
    `WTI ${b('$' + wl.v.toFixed(2))} (전일 ${sgnPct(wl.v, wp.v)} · 1개월 ${sgnPct(wl.v, ago(w, 30).v)} · 1년 ${sgnPct(wl.v, ago(w, 365).v)})\n   3년 범위 $${wlo.v.toFixed(2)}~$${whi.v.toFixed(2)}`,
    '',
    html ? '<i>자료: FRED (ICE BofA OAS · 나스닥 · 미 재무부 · EIA) · 그래프는 주간 값</i>' : '자료: FRED (ICE BofA OAS · 미 재무부 · EIA)',
  ].join('\n');
}

async function sendAlbum(pngs, cap) {
  const fd = new FormData();
  fd.append('chat_id', String(ENV.TELEGRAM_CHAT_ID));
  fd.append('media', JSON.stringify(pngs.map((_, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 ? { caption: cap, parse_mode: 'HTML' } : {}) }))));
  pngs.forEach((png, i) => fd.append(`p${i}`, new Blob([png], { type: 'image/png' }), `us${i + 1}.png`));
  const r = await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMediaGroup`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`텔레그램 전송 실패 ${r.status} ${(await r.text()).slice(0, 150)}`);
}

async function main() {
  const alerts = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'alerts.json'), 'utf8').catch(() => '{}'));
  const prev = JSON.parse(await fs.readFile(FILE, 'utf8').catch(() => '{}'));
  const from = new Date(Date.now() - (3 * 365 + 5) * 86400000).toISOString().slice(0, 10);
  const d = {};
  for (const [k, id] of Object.entries(SERIES)) {
    d[k] = await fetchFred(id, from);
    if (d[k].length < 30) throw new Error(`${id} 자료가 너무 적어요 (${d[k].length}일)`);
  }
  const asOf = d.hy.at(-1).date;
  const charts = async () => [
    await spreadChart(d.hy, d.ig, d.nasdaq),
    await singleChart(d.t10, '② 미국 10년물 국채금리', '10년물 금리', '%', '#2f9e44'),
    await singleChart(d.wti, '③ WTI 유가', 'WTI 현물', '달러/배럴', '#5f3dc4'),
  ];
  if (PRINT) {
    console.log(caption(d, false));
    if (PNG_DIR) (await charts()).forEach((p, i) => fss_write(path.join(PNG_DIR, `us${i + 1}.png`), p));
    return;
  }
  const save = (sentFor) => fs.writeFile(FILE, JSON.stringify({ updatedAt: new Date().toISOString(), asOf, unit: { hy: '%', ig: '%', t10: '%', wti: 'USD/bbl' }, source: 'FRED ' + Object.values(SERIES).join(', '), series: d, sentFor }));
  await save(prev.sentFor || null);
  log(`${asOf} 기준 하이일드 ${d.hy.at(-1).v}% · 투자등급 ${d.ig.at(-1).v}% · 나스닥 ${d.nasdaq.at(-1).v} · 10년물 ${d.t10.at(-1).v}% · WTI $${d.wti.at(-1).v} (${d.wti.at(-1).date})`);

  if (!FORCE && prev.sentFor === asOf) { log('이 날짜는 이미 보냈어요'); return; }
  if (alerts.usmacro === false) { log('미국 지표 알림이 꺼져 있어요'); return; }
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) { log('텔레그램 설정 없음'); return; }
  await sendAlbum(await charts(), caption(d));
  await save(asOf);
  log('텔레그램으로 보냈어요');
}
const fss_write = (f, buf) => fs.writeFile(f, buf);

main().catch((e) => { console.error('[usmacro] 실패:', e.message); process.exit(1); });
