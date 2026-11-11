// 보유 종목의 새 공시(DART)·증권사 리포트(네이버)를 텔레그램으로 알려줍니다.
// GitHub Actions가 평일 07~21시에 15분마다 실행.
//   node scripts/news.mjs          새 항목 확인 → 알림
//   처음 실행 때는 지금까지 나온 것을 '본 것'으로만 기록하고 알림은 보내지 않아요.
//
// 어떤 종목을 보유했는지 드러나지 않도록, 본 항목 기록은 암호화해서 저장해요(data/news-state.enc.json).

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encryptJSON, decryptJSON } from './brokers.mjs';
import { UA, kstNow } from './strategy-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env;
const PW = ENV.HOLDINGS_PASSWORD, DART = ENV.DART_API_KEY;
const STATE = path.join(ROOT, 'data', 'news-state.enc.json');
const log = (...a) => console.log('[news]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function readJSON(p, fb) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fb; } }

async function telegram(text) {
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) { log('텔레그램 설정 없음'); return false; }
  const r = await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) log('텔레그램 실패', r.status);
  return r.ok;
}

// DART 고유번호 (data/corp_codes.json 캐시, 없으면 corpCode.xml zip 에서 찾기)
function unzipFirst(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const cd = buf.readUInt32LE(eocd + 16), method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  return method === 0 ? data : zlib.inflateRawSync(data);
}
async function corpCodes(codes) {
  const f = path.join(ROOT, 'data', 'corp_codes.json');
  const cache = await readJSON(f, {});
  if (codes.every((c) => c in cache)) return cache;
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART}`, { headers: UA });
  const xml = unzipFirst(Buffer.from(await res.arrayBuffer())).toString('utf8');
  const re = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>[^<]*<\/corp_name>\s*(?:<corp_eng_name>[^<]*<\/corp_eng_name>\s*)?<stock_code>\s*(\d{6})\s*<\/stock_code>/g;
  for (const m of xml.matchAll(re)) if (codes.includes(m[2])) cache[m[2]] = m[1];
  for (const c of codes) if (!(c in cache)) cache[c] = null;
  await fs.writeFile(f, JSON.stringify(cache, null, 2));
  return cache;
}

async function main() {
  if (!PW) { log('HOLDINGS_PASSWORD 가 없어 보유 종목을 알 수 없어요'); return; }
  const alerts = await readJSON(path.join(ROOT, 'config', 'alerts.json'), {});
  if (alerts.news === false) { log('공시·리포트 알림이 꺼져 있어요'); return; }

  const holdBox = await readJSON(path.join(ROOT, 'data', 'holdings.enc.json'), null);
  if (!holdBox) { log('잔고 파일이 없어요'); return; }
  const hold = decryptJSON(holdBox, PW);
  const stocks = new Map();
  for (const h of hold.items) if (/^\d{6}$/.test(h.code)) stocks.set(h.code, h.name);  // 국내 종목만
  log(`보유 국내 종목 ${stocks.size}개 확인`);

  let state = { seen: [], init: false };
  try { state = decryptJSON(await readJSON(STATE, null), PW); } catch {}
  const seen = new Set(state.seen);
  const fresh = [];

  // 1) DART 공시: 최근 3일
  if (DART) {
    const codes = await corpCodes([...stocks.keys()]);
    const end = kstNow(), start = new Date(end.getTime() - 3 * 86400000);
    for (const [code, name] of stocks) {
      const cc = codes[code]; if (!cc) continue;
      try {
        const j = await (await fetch(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART}&corp_code=${cc}&bgn_de=${ymd(start)}&end_de=${ymd(end)}&page_count=30`, { headers: UA })).json();
        for (const d of j.list || []) {
          const id = 'D' + d.rcept_no;
          if (!seen.has(id)) fresh.push({ id, kind: 'dart', code, name, title: d.report_nm.trim(), date: d.rcept_dt, filer: d.flr_nm, url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}` });
        }
      } catch (e) { log(`공시 조회 실패 ${name}: ${e.message}`); }
      await sleep(120);
    }
  }
  // 2) 증권사 리포트 (네이버 증권)
  for (const [code, name] of stocks) {
    try {
      const j = await (await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, { headers: UA })).json();
      for (const r of j.researches || []) {
        const id = 'R' + r.id;
        if (!seen.has(id)) fresh.push({ id, kind: 'report', code, name, title: r.tit, broker: r.bnm, date: r.wdt, url: `https://finance.naver.com/research/company_read.naver?nid=${r.id}` });
      }
    } catch (e) { log(`리포트 조회 실패 ${name}: ${e.message}`); }
    await sleep(150);
  }

  // 처음 실행: 기존 항목은 알림 없이 기록만
  const sendable = state.init ? fresh : [];
  if (!state.init) log(`처음 실행이라 기존 ${fresh.length}건은 알림 없이 기록만 해요`);
  // 오래된 것부터 보내기
  sendable.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let sent = 0;
  for (const it of sendable.slice(0, 20)) {
    const d = String(it.date).replace(/(\d{4})(\d{2})(\d{2})/, '$2/$3');
    const text = it.kind === 'dart'
      ? `📢 <b>공시 · ${esc(it.name)}</b>\n${esc(it.title)}\n${d}${it.filer && it.filer !== it.name ? ' · 제출 ' + esc(it.filer) : ''}\n<a href="${it.url}">DART에서 보기</a>`
      : `📝 <b>리포트 · ${esc(it.name)}</b>\n"${esc(it.title)}"\n${esc(it.broker)} · ${d}\n<a href="${it.url}">리포트 보기</a>`;
    if (await telegram(text)) sent++;
    await sleep(400);
  }
  if (sendable.length > 20) await telegram(`그 밖에 새 공시·리포트 ${sendable.length - 20}건이 더 있어요. 사이트 종목 상세에서 확인하세요.`);
  for (const it of fresh) seen.add(it.id);

  const changed = fresh.length > 0 || !state.init;
  if (changed) {
    const keep = [...seen].slice(-3000);
    await fs.writeFile(STATE, JSON.stringify(encryptJSON({ init: true, seen: keep, updatedAt: new Date().toISOString() }, PW)));
  }
  log(`새 항목 ${fresh.length}건 · 알림 ${sent}건`);
}

main().catch((e) => { console.error(e); process.exit(1); });
