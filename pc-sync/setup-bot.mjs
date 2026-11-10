// 텔레그램 봇 설정을 config.json 에 추가합니다.  실행: node setup-bot.mjs
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

console.log('\n=== 텔레그램 봇 설정 ===\n');
let token = '';
while (!/^\d+:[\w-]{20,}$/.test(token)) token = await ask('1) 봇 토큰 (BotFather가 준 숫자:문자 형식)');
let chatId = '';
while (!/^-?\d+$/.test(chatId)) chatId = await ask('2) chat id (봇이 보내준 숫자, GitHub의 TELEGRAM_CHAT_ID와 같은 값)');
rl.close();

cfg.telegram = { token, chatId };
await fs.writeFile(file, JSON.stringify(cfg, null, 2));
console.log('\n✔ 봇 설정을 저장했어요. 이제 실행:  node bot.mjs\n');
