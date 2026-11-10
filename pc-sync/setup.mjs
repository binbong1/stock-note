// config.json 만들기 도우미: 질문에 답하면 config.json 을 만들어 줍니다.
// 실행: node setup.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const rl = readline.createInterface({ input, output, terminal: input.isTTY });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q, def = '') => {
  output.write(def ? `${q} [${def}]: ` : `${q}: `);
  const { value, done } = await lines.next();
  if (done) { console.log('\n입력이 중간에 끝났어요. 다시 실행해 주세요.'); process.exit(1); }
  const a = String(value).trim();
  return a || def;
};

console.log('\n=== 내 주식 노트 · PC 동기화 설정 ===');
console.log('값을 붙여넣고 엔터를 누르세요. (대괄호 안 값은 그냥 엔터 치면 그대로 사용)\n');

let password = '';
while (password.length < 8) password = await ask('1) 사이트 잠금 비밀번호 (GitHub의 HOLDINGS_PASSWORD와 똑같이, 8자 이상)');
const owner = await ask('2) GitHub 아이디', 'binbong1');
const repo = await ask('3) 저장소 이름', 'stock-note');
let token = '';
while (!/^(github_pat_|ghp_)/.test(token)) token = await ask('4) GitHub 토큰 (github_pat_ 또는 ghp_ 로 시작)');

const count = Number(await ask('5) 키움 계좌 개수', '2')) || 0;
const kiwoom = [];
for (let i = 1; i <= count; i++) {
  const appkey = await ask(`   키움 계좌 ${i} App Key`);
  const secretkey = await ask(`   키움 계좌 ${i} Secret Key`);
  if (appkey && secretkey) kiwoom.push({ appkey, secretkey });
}
rl.close();

const cfg = {
  password,
  github: { owner, repo, branch: 'main', token, runWorkflow: true },
  kiwoom,
  kis: { appkey: '', appsecret: '', account: '' },
};
await fs.writeFile(path.join(DIR, 'config.json'), JSON.stringify(cfg, null, 2));
console.log(`\n✔ config.json 을 만들었어요 (키움 계좌 ${kiwoom.length}개).`);
console.log('이제 이어서 실행:  node sync.mjs\n');
