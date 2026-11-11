// 내 PC에서 실행하는 잔고·실현손익 동기화 (키움은 등록된 IP에서만 조회되므로 PC에서 실행)
// 1) 키움(필요하면 한국투자증권도) 잔고 + 실현손익 조회
// 2) 비밀번호로 암호화
// 3) GitHub 저장소의 data/holdings-local.enc.json 에 업로드
// 4) '주식 데이터 수집' 워크플로를 바로 실행시켜 대시보드 갱신
//
// 실행: node sync.mjs   (같은 폴더의 config.json 을 읽습니다)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptJSON } from './brokers.mjs';
import { fetchKiwoom, fetchKiwoomRealized, fetchKiwoomUS, fetchKiwoomUSRealized, fetchKIS, fetchKISRealized, fetchToss, weekdays, encryptJSON } from './brokers.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// 윈도우 PC 로컬 모드: --local 이면 GitHub에 올리지 않고 저장소 폴더의 data 에 바로 저장
const LOCAL = process.argv.includes('--local') || process.env.STOCKNOTE_LOCAL === '1';
const CONFIG_PATH = process.env.STOCKNOTE_CONFIG || path.join(DIR, 'config.json');
const LOCAL_FILE = path.join(DIR, '..', 'data', 'holdings-local.enc.json');
const log = (...a) => console.log(new Date().toLocaleString('ko-KR'), '|', ...a);

async function gh(cfg, method, p, body) {
  const res = await fetch(`https://api.github.com/repos/${cfg.github.owner}/${cfg.github.repo}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.github.token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'stock-note-pc-sync',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`GitHub ${method} ${p}: HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
  return res.status === 204 ? {} : res.json();
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  if (!cfg.password || cfg.password.length < 8) throw new Error('config.json 의 password 는 8자 이상으로 정해 주세요');

  // 실현손익을 처음 한 번은 1년치, 그다음부터는 최근 14일만 조회 (state.json 에 기록)
  const stateFile = LOCAL ? path.join(DIR, '..', 'local', 'sync-state.json') : path.join(DIR, 'state.json');
  let state = {};
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch {}

  const kst = new Date(Date.now() + 9 * 3600000);
  const today = kst.toISOString().slice(0, 10);
  const items = [], accounts = [], realized = [];
  const skipped = new Set();
  const skippedLabels = [];

  // 키움 계좌마다 국내·미국 잔고를 모두 확인 (config 의 market 을 "kr" 또는 "us" 로 정하면 그쪽만)
  for (const [i, k] of (cfg.kiwoom || []).entries()) {
    if (!k.appkey) continue;
    const mode = (k.market || 'auto').toLowerCase();
    const n = i + 1;

    let krCount = 0;
    if (mode !== 'us') {
      try {
        const r = await fetchKiwoom(k, i);
        items.push(...r.items); krCount = r.items.length;
        if (r.items.length || mode === 'kr') accounts.push(...r.accounts);
        log(`키움 계좌 ${n} 국내: ${r.items.length}종목`);
      } catch (e) {
        log(`키움 계좌 ${n} 국내 잔고 조회 실패: ${e.message}`);
        if (/토큰|IP/.test(e.message)) { log(`키움 계좌 ${n}: 접속이 안 돼서 이 계좌는 건너뛰어요 (지난번 올린 값이 사이트에 그대로 남아요)`); skipped.add(i); continue; }
      }
    }
    if (mode !== 'kr') {
      try {
        const r = await fetchKiwoomUS(k, i);
        items.push(...r.items); accounts.push(...r.accounts);
        log(`키움 계좌 ${n} 해외(미국): ${r.items.length}종목`);
      } catch (e) { log(`키움 계좌 ${n} 해외 잔고 조회 실패: ${e.message}`); }
    }

    // 실현손익: 처음 1년치, 이후 최근 14일
    if (mode === 'kr' || (mode === 'auto' && krCount > 0)) {
      try {
        const key = `kiwoom:${i}`;
        const from = new Date(kst.getTime() - (state[key] ? 14 : 365) * 86400000);
        if (!state[key]) log(`키움 계좌 ${n} 국내: 처음이라 1년치 실현손익을 가져와요 (1~2분)`);
        const rr = await fetchKiwoomRealized(k, weekdays(from, kst), i);
        realized.push({ broker: '키움', account: rr.account, from: from.toISOString().slice(0, 10), to: today, rows: rr.rows });
        state[key] = today;
        log(`키움 계좌 ${n} 국내 실현손익: ${rr.rows.length}건`);
      } catch (e) { log(`키움 계좌 ${n} 국내 실현손익 실패: ${e.message}`); }
    }
    if (mode !== 'kr') {
      try {
        const key = `kiwoom-us:${i}`;
        const from = new Date(kst.getTime() - (state[key] ? 14 : 365) * 86400000);
        if (!state[key]) log(`키움 계좌 ${n} 해외: 처음이라 1년치 실현손익을 가져와요 (2~3분)`);
        const rr = await fetchKiwoomUSRealized(k, weekdays(from, kst, true), i);
        realized.push({ broker: '키움', account: rr.account, from: from.toISOString().slice(0, 10), to: today, rows: rr.rows });
        state[key] = today;
        log(`키움 계좌 ${n} 해외 실현손익: ${rr.rows.length}건`);
      } catch (e) { log(`키움 계좌 ${n} 해외 실현손익 실패: ${e.message}`); }
    }
  }
  // 토스증권 (잔고만 — 토스는 실현손익 API가 없음)
  for (const [i, t] of (cfg.toss || []).entries()) {
    if (!t.clientId) continue;
    try {
      const r = await fetchToss(t, i);
      items.push(...r.items); accounts.push(...r.accounts);
      log(`토스 계좌 ${i + 1}: ${r.items.length}종목`);
    } catch (e) { log(`토스 계좌 ${i + 1} 조회 실패: ${e.message}`); skippedLabels.push(`토스 계좌 ${i + 1}`); }
  }
  if (cfg.kis?.appkey) {
    const r = await fetchKIS(cfg.kis);
    items.push(...r.items); accounts.push(...r.accounts);
    const back = state.kis ? 14 : 365;
    const from = new Date(kst.getTime() - back * 86400000).toISOString().slice(0, 10);
    const rr = await fetchKISRealized(cfg.kis, from.replace(/-/g, ''), today.replace(/-/g, ''));
    realized.push({ broker: 'KIS', account: rr.account, from, to: today, rows: rr.rows });
    state.kis = today;
    log(`한국투자증권: ${r.items.length}종목, 실현손익 ${rr.rows.length}건`);
  }

  const filePath = '/contents/data/holdings-local.enc.json';
  const cur = LOCAL ? await fs.readFile(LOCAL_FILE, 'utf8').then((t) => ({ content: Buffer.from(t).toString('base64') })).catch(() => null) : await gh(cfg, 'GET', filePath);
  // 접속 실패한 계좌는 지난번 올린 값을 그대로 유지 (사이트에서 계좌가 사라지지 않게)
  for (const i of skipped) skippedLabels.push(`키움 계좌 ${i + 1}`);
  if (skippedLabels.length) {
    if (!items.length && !accounts.length) throw new Error('모든 계좌 접속에 실패해서 이번에는 올리지 않았어요 (IP 등록을 확인하세요)');
    try {
      const prev = decryptJSON(JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8')), cfg.password);
      const keep = (label) => skippedLabels.some((p) => label === p || label.startsWith(p + ' ') || label.startsWith(p + '-'));
      items.push(...prev.items.filter((h) => keep(h.account || '')));
      accounts.push(...(prev.accounts || []).filter((a) => keep(a.account || '')));
      log(`접속 실패 계좌(${skippedLabels.join(', ')})는 지난번 값을 유지해요`);
    } catch (e) { log('지난번 값을 불러오지 못했어요:', e.message); }
  }
  const box = encryptJSON({ updatedAt: new Date().toISOString(), items, accounts, realized }, cfg.password);
  if (LOCAL) {
    await fs.writeFile(LOCAL_FILE, JSON.stringify(box));
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
    log('암호화한 잔고를 PC에 저장했어요');
    return;
  }
  await gh(cfg, 'PUT', filePath, {
    message: 'PC 잔고 동기화',
    content: Buffer.from(JSON.stringify(box)).toString('base64'),
    sha: cur?.sha,
  });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
  log('암호화한 잔고를 GitHub에 올렸어요');

  if (cfg.github.runWorkflow !== false) {
    await gh(cfg, 'POST', '/actions/workflows/collect.yml/dispatches', { ref: cfg.github.branch || 'main' });
    log('대시보드 갱신(워크플로)을 요청했어요. 1~2분 뒤 사이트를 새로고침하세요.');
  }
}

main().catch((e) => { log('실패:', e.message); process.exit(1); });
