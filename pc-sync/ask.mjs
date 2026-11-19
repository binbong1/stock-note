// 주식봇 기능을 명령줄에서 실행 — 텔레그램의 Claude가 계좌 현황 등을 가져올 때 사용
//   node pc-sync/ask.mjs 현황        (계좌 상세: 계좌 / 실현 이번달 / 신호 / 신용 / 감시 / 기준 / 입출금 / 종목명)
// 출력은 텔레그램에 그대로 옮기기 좋은 일반 텍스트. 키·비밀번호는 출력하지 않아요.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.STOCKNOTE_LOCAL ||= '1';
process.env.STOCKNOTE_CONFIG ||= path.join(ROOT, 'local', 'config.json');
const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.log('사용법: node pc-sync/ask.mjs 현황'); process.exit(1); }
const { handle } = await import('./bot.mjs');
let out = await handle(text);
if (out && typeof out === 'object') out = out.plain ?? out.html ?? '';
console.log(String(out ?? '').replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2 ($1)').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
process.exit(0);
