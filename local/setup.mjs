// 윈도우 PC 설정 도우미 — 질문에 답하면 local\config.json 을 만들어 줍니다.
// 실행: node local\setup.mjs   (install-windows.bat 이 자동으로 실행)
// 이미 config.json 이 있으면 각 질문에서 엔터만 치면 기존 값을 그대로 써요.
// 키·비밀번호는 이 PC의 local\config.json 에만 저장되고 GitHub에는 올라가지 않아요.

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { decryptJSON } from '../pc-sync/brokers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'local', 'config.json');

const rl = readline.createInterface({ input, output, terminal: input.isTTY });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q, def = '') => {
  const shown = def ? (def.length > 12 ? def.slice(0, 4) + '…' + def.slice(-3) : def) : '';
  output.write(shown ? `${q} [엔터=그대로 ${shown}]: ` : `${q}: `);
  const { value, done } = await lines.next();
  if (done) { console.log('\n입력이 중간에 끝났어요. 다시 실행해 주세요.'); process.exit(1); }
  return String(value).trim() || def;
};
const yes = async (q, def = 'y') => /^y/i.test(await ask(`${q} (y/n)`, def));

let cfg = {};
try { cfg = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch {}

console.log('\n=== 내 주식 노트 · 윈도우 PC 설정 ===');
console.log('값을 붙여넣고 엔터를 누르세요. (붙여넣기: 마우스 오른쪽 클릭 또는 Ctrl+V)\n');

// 맥북에서 쓰던 config.json 이 있으면 가져오기
if (!cfg.password && await yes('맥북에서 쓰던 config.json 파일(USB 등으로 옮긴 것)을 가져올까요?', 'n')) {
  const p = (await ask('   그 파일 경로 (파일을 이 창에 끌어다 놓으면 경로가 들어가요)')).replace(/^"|"$/g, '');
  try {
    const mac = JSON.parse(await fs.readFile(p, 'utf8'));
    cfg = { ...mac, ...cfg };
    console.log(`   ✔ 가져왔어요 (키움 ${mac.kiwoom?.length || 0}개, 토스 ${mac.toss?.length || 0}개, 텔레그램 ${mac.telegram ? '있음' : '없음'})\n`);
  } catch (e) { console.log('   ✖ 못 읽었어요:', e.message, '→ 직접 입력으로 진행해요\n'); }
}

// 1) 비밀번호 — 지금 사이트 데이터로 맞는지 바로 확인
for (;;) {
  cfg.password = await ask('1) 사이트 잠금 비밀번호 (GitHub의 HOLDINGS_PASSWORD와 똑같이)', cfg.password || '');
  try {
    const box = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'holdings.enc.json'), 'utf8'));
    decryptJSON(box, cfg.password);
    console.log('   ✔ 비밀번호가 맞아요 (지금 사이트 데이터가 풀려요)');
    break;
  } catch (e) {
    if (e.code === 'ENOENT') break;
    console.log('   ✖ 이 비밀번호로는 사이트 데이터가 안 풀려요. 다시 입력해 주세요.');
    cfg.password = '';
  }
}

// 2) GitHub (휴대폰 사이트 반영용)
cfg.github = { owner: 'binbong1', repo: 'stock-note', branch: 'main', ...(cfg.github || {}) };
delete cfg.github.runWorkflow;
let tok = '';
while (!/^(github_pat_|ghp_)/.test(tok)) tok = await ask('2) GitHub 토큰 (github_pat_ 로 시작, 맥북에서 쓰던 것 그대로 OK)', cfg.github.token || '');
cfg.github.token = tok;

// 3) DART
cfg.dart = await ask('3) DART 인증키 (opendart.fss.or.kr → 마이페이지 → 인증키, 40자)', cfg.dart || '');

// 4) 한국투자증권
const kisN = Number(await ask('4) 한국투자증권 계좌 개수', String(cfg.kisAccounts?.length || 2))) || 0;
const kis = [];
for (let i = 0; i < kisN; i++) {
  const p = cfg.kisAccounts?.[i] || {};
  console.log(`   [한투${i + 1}]`);
  const appkey = await ask('     App Key', p.appkey || '');
  const appsecret = await ask('     App Secret', p.appsecret || '');
  const account = await ask('     계좌번호 (예: 12345678-01)', p.account || '');
  if (appkey && appsecret && account) kis.push({ appkey, appsecret, account });
}
cfg.kisAccounts = kis;

// 5) 키움
const kwN = Number(await ask('5) 키움 계좌 개수', String(cfg.kiwoom?.length || 2))) || 0;
const kw = [];
for (let i = 0; i < kwN; i++) {
  const p = cfg.kiwoom?.[i] || {};
  console.log(`   [키움 계좌 ${i + 1}]`);
  const appkey = await ask('     App Key', p.appkey || '');
  const secretkey = await ask('     Secret Key', p.secretkey || '');
  if (appkey && secretkey) kw.push({ ...p, appkey, secretkey });
}
cfg.kiwoom = kw;

// 6) 토스
const t0 = cfg.toss?.[0] || {};
const clientId = await ask('6) 토스증권 client_id (없으면 엔터)', t0.clientId || '');
const clientSecret = clientId ? await ask('   토스증권 client_secret', t0.clientSecret || '') : '';
cfg.toss = clientId && clientSecret ? [{ ...t0, clientId, clientSecret }] : [];

// 7) 텔레그램
const tg = cfg.telegram || {};
let token = '';
while (!/^\d+:[\w-]{20,}$/.test(token)) token = await ask('7) 텔레그램 봇 토큰 (숫자:문자)', tg.token || '');
let chatId = '';
while (!/^-?\d+$/.test(chatId)) chatId = await ask('   텔레그램 chat id (숫자)', tg.chatId ? String(tg.chatId) : '');
cfg.telegram = { token, chatId };

cfg.server = { port: 8080, host: '127.0.0.1', ...(cfg.server || {}) };
delete cfg.kis; // 한투는 kisAccounts 로 수집 (예전 맥북 설정 정리)
rl.close();

await fs.mkdir(path.dirname(FILE), { recursive: true });
await fs.writeFile(FILE, JSON.stringify(cfg, null, 2));
console.log(`\n✔ 저장했어요: ${FILE}`);
console.log(`   한투 ${kis.length}개 · 키움 ${kw.length}개 · 토스 ${cfg.toss.length}개 · DART ${cfg.dart ? '있음' : '없음'} · 텔레그램 있음\n`);
