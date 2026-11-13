// 코스피·코스닥 신용거래융자 잔고 → 6개월 그래프 + 최근 5일 표를 텔레그램으로 보냅니다.
//   node scripts/credit.mjs          새 기준일 자료가 나왔으면 보냄 (이미 보낸 날짜면 건너뜀)
//   node scripts/credit.mjs --force  다시 보냄
// 자료: 금융투자협회 종합통계(freesis) '신용공여 잔고 추이' (단위 백만원). 보통 하루 늦게(전 거래일 기준) 나와요.
// 그래프 이미지는 quickchart.io 로 만들어요 (공개 시장 자료만 보냄).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env;
const FILE = path.join(ROOT, 'data', 'credit.json');
const FORCE = process.argv.includes('--force');
const log = (...a) => console.log('[credit]', ...a);
const kst = () => new Date(Date.now() + 9 * 3600000);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function fetchKofia(from, to) {
  const r = await fetch('https://freesis.kofia.or.kr/meta/getMetaDataList.do', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': 'Mozilla/5.0', Referer: 'https://freesis.kofia.or.kr/' },
    body: JSON.stringify({ dmSearch: { tmpV40: '1000000', tmpV41: '1', tmpV1: 'D', tmpV45: from, tmpV46: to, OBJ_NM: 'STATSCU0100000070BO' } }),
  });
  if (!r.ok) throw new Error(`금융투자협회 HTTP ${r.status}`);
  const j = await r.json();
  // TMPV1 날짜, TMPV2 신용거래융자 전체, TMPV3 유가증권, TMPV4 코스닥 (백만원)
  return (j.ds1 || []).map((x) => ({ date: `${x.TMPV1.slice(0, 4)}-${x.TMPV1.slice(4, 6)}-${x.TMPV1.slice(6, 8)}`, total: x.TMPV2, kospi: x.TMPV3, kosdaq: x.TMPV4 }))
    .filter((x) => x.kospi > 0).sort((a, b) => a.date.localeCompare(b.date));
}

const jo = (m) => (m / 1e6).toFixed(2) + '조';                     // 백만원 → 조
const eok = (m) => { const v = Math.round(m / 100); return (v > 0 ? '+' : v < 0 ? '-' : '±') + Math.abs(v).toLocaleString('ko-KR') + '억'; };
const pct = (a, b) => (b ? ((a / b - 1) * 100) : 0);
const pad = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };

async function chartPng(rows) {
  const labels = rows.map((r) => r.date.slice(5).replace('-', '/'));
  const cfg = {
    type: 'line',
    data: { labels, datasets: [
      { label: '코스피', data: rows.map((r) => +(r.kospi / 1e6).toFixed(3)), borderColor: '#d9480f', backgroundColor: 'rgba(217,72,15,0.08)', fill: true, pointRadius: 0, borderWidth: 2, yAxisID: 'y' },
      { label: '코스닥', data: rows.map((r) => +(r.kosdaq / 1e6).toFixed(3)), borderColor: '#1c7ed6', pointRadius: 0, borderWidth: 2, yAxisID: 'y1' },
    ] },
    options: {
      plugins: { title: { display: true, text: `신용거래융자 잔고 (최근 6개월, ${rows.at(-1).date} 기준)`, font: { size: 16 } }, legend: { position: 'bottom' } },
      scales: {
        x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } },
        y: { position: 'left', title: { display: true, text: '코스피 (조원)' }, ticks: { color: '#d9480f' } },
        y1: { position: 'right', title: { display: true, text: '코스닥 (조원)' }, ticks: { color: '#1c7ed6' }, grid: { drawOnChartArea: false } },
      },
    },
  };
  const r = await fetch('https://quickchart.io/chart', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ version: '4', width: 900, height: 500, devicePixelRatio: 2, backgroundColor: 'white', format: 'png', chart: cfg }),
  });
  if (!r.ok) throw new Error(`그래프 만들기 실패 HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function caption(rows) {
  const last = rows.at(-1), prev = rows.at(-2);
  const m6 = rows[0];
  const recent = rows.slice(-6); // 5일 + 비교용 하루
  const lines = [];
  for (let i = recent.length - 1; i >= 1; i--) {
    const r = recent[i], p = recent[i - 1];
    lines.push(`${r.date.slice(5).replace('-', '/')} ${pad(jo(r.kospi), 7)} ${pad(eok(r.kospi - p.kospi), 8)} ${pad(jo(r.kosdaq), 6)} ${pad(eok(r.kosdaq - p.kosdaq), 7)}`);
  }
  return [
    `<b>📊 신용거래융자 잔고</b> (${last.date} 기준)`,
    `코스피 <b>${jo(last.kospi)}</b> ${eok(last.kospi - prev.kospi)} (${pct(last.kospi, prev.kospi).toFixed(2)}%)`,
    `코스닥 <b>${jo(last.kosdaq)}</b> ${eok(last.kosdaq - prev.kosdaq)} (${pct(last.kosdaq, prev.kosdaq).toFixed(2)}%)`,
    `합계 ${jo(last.kospi + last.kosdaq)} · 6개월 전 대비 코스피 ${pct(last.kospi, m6.kospi).toFixed(1)}%, 코스닥 ${pct(last.kosdaq, m6.kosdaq).toFixed(1)}%`,
    '',
    '<b>최근 5거래일</b> (전일 대비)',
    `<pre>날짜     코스피    증감    코스닥    증감\n${lines.join('\n')}</pre>`,
    '<i>자료: 금융투자협회 · 보통 전 거래일 기준으로 나와요</i>',
  ].join('\n');
}

async function sendPhoto(png, cap) {
  const fd = new FormData();
  fd.append('chat_id', String(ENV.TELEGRAM_CHAT_ID));
  fd.append('caption', cap);
  fd.append('parse_mode', 'HTML');
  fd.append('photo', new Blob([png], { type: 'image/png' }), 'credit.png');
  const r = await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`텔레그램 전송 실패 ${r.status} ${(await r.text()).slice(0, 150)}`);
}

async function main() {
  const alerts = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'alerts.json'), 'utf8').catch(() => '{}'));
  const prev = JSON.parse(await fs.readFile(FILE, 'utf8').catch(() => '{}'));
  const now = kst();
  const from = new Date(now.getTime() - 190 * 86400000);
  const rows = await fetchKofia(ymd(from), ymd(now));
  if (rows.length < 6) throw new Error(`자료가 너무 적어요 (${rows.length}일)`);
  const last = rows.at(-1);
  // 사이트·봇에서 쓸 수 있게 공개 시장 자료를 저장
  await fs.writeFile(FILE, JSON.stringify({ updatedAt: new Date().toISOString(), asOf: last.date, unit: '백만원', rows, sentFor: prev.sentFor || null }));
  log(`${last.date} 기준 코스피 ${jo(last.kospi)} · 코스닥 ${jo(last.kosdaq)} (${rows.length}일)`);

  if (!FORCE && prev.sentFor === last.date) { log('이 날짜는 이미 보냈어요'); return; }
  if (alerts.credit === false) { log('신용잔고 알림이 꺼져 있어요'); return; }
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) { log('텔레그램 설정 없음'); return; }
  const png = await chartPng(rows);
  await sendPhoto(png, caption(rows));
  await fs.writeFile(FILE, JSON.stringify({ updatedAt: new Date().toISOString(), asOf: last.date, unit: '백만원', rows, sentFor: last.date }));
  log('텔레그램으로 보냈어요');
}

main().catch((e) => { console.error('[credit] 실패:', e.message); process.exit(1); });
