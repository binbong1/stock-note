// 토스증권 Open API 키를 config.json 에 추가합니다.  실행: node setup-toss.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(DIR, 'config.json');
let cfg;
try { cfg = JSON.parse(await fs.readFile(file, 'utf8')); }
catch { console.log('config.json 이 없어요. 먼저 node setup.mjs 를 실행하세요.'); process.exit(1); }
const rl = readline.createInterface({ input, output, terminal: input.isTTY });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => { output.write(q + ': '); const { value, done } = await lines.next(); if (done) process.exit(1); return String(value).trim(); };

console.log('\n=== 토스증권 Open API 설정 ===\n');
let clientId = '', clientSecret = '';
while (!clientId) clientId = await ask('1) client_id');
while (!clientSecret) clientSecret = await ask('2) client_secret');
rl.close();
cfg.toss = [{ clientId, clientSecret }];
await fs.writeFile(file, JSON.stringify(cfg, null, 2));
console.log('\n✔ 토스 설정을 저장했어요. 이제 실행:  node sync.mjs\n');
