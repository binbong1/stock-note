// 윈도우 설치 (install-windows.bat 이 실행). 한글 안내는 모두 여기서 출력해요.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, args, opt = {}) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opt });
const ask = async (q) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(q); rl.close(); return a.trim(); };

console.log('\n==== 내 주식 노트 : 윈도우 PC 설치 ====\n');

// 줄바꿈 문자 정리 (윈도우가 설정 파일을 바꾼 것처럼 보이지 않게)
sh('git', ['config', 'core.autocrlf', 'false'], { stdio: 'ignore' });
sh('git', ['pull', '-q', '--autostash', 'origin', 'main'], { stdio: 'ignore' });

console.log('[1/4] 키와 비밀번호 설정');
if (sh(process.execPath, ['local/setup.mjs']).status !== 0) process.exit(1);

console.log('\n[2/4] 증권사 접속 확인 (키움·토스 → 한투·시세 수집)');
let ip = '확인 실패';
try { ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) })).text()).trim(); } catch {}
console.log(`     이 PC의 공인 IP: ${ip}`);
const r = sh(process.execPath, ['local/run.mjs', 'job', 'sync']);
// 한투 잔고와 시세는 collect 에서 가져오므로 같이 실행 (사이트에 바로 반영)
sh(process.execPath, ['local/run.mjs', 'job', 'collect']);
if (r.status !== 0) {
  console.log(`\n     ⚠ 키움/토스 접속이 안 됐어요. 각 개발자 사이트의 허용 IP에 ${ip} 를 추가한 뒤`);
  console.log('       local\\run-now.bat 에서 1번을 누르면 다시 가져와요. (나머지 설치는 계속 진행해요)\n');
}

console.log('\n[3/4] 켤 때마다 자동 실행 등록');
const startup = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'StockNote.vbs');
const vbs = `CreateObject("WScript.Shell").Run """${path.join(ROOT, 'local', 'start.cmd')}""", 0, False\r\n`;
// UTF-16(BOM) 으로 저장해야 경로에 한글이 있어도 wscript 가 읽어요
await fs.writeFile(startup, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
console.log(`     등록했어요: ${startup}`);

if (/^y/i.test(await ask('     PC가 절전모드로 들어가지 않게 할까요? 전원 연결 시, 권장 (y/n): '))) {
  sh('powercfg', ['/change', 'standby-timeout-ac', '0']);
  sh('powercfg', ['/change', 'hibernate-timeout-ac', '0']);
  console.log('     절전 안 함으로 바꿨어요 (화면은 꺼져도 괜찮아요)');
}

console.log('\n[4/4] 시작');
let running = false;
try { await fetch('http://127.0.0.1:8080/__status', { signal: AbortSignal.timeout(2000) }); running = true; } catch {}
if (running) {
  console.log('     이미 실행 중이라 새 버전으로 다시 켤게요');
  try { await fetch('http://127.0.0.1:8080/__stop'); } catch {}
  await new Promise((res) => setTimeout(res, 4000));
}
spawn('wscript', [startup], { detached: true, stdio: 'ignore' }).unref();
await new Promise((res) => setTimeout(res, 6000));
spawn('cmd', ['/c', 'start', '', 'http://localhost:8080'], { detached: true, stdio: 'ignore' }).unref();

console.log(`
==== 완료 ====
 사이트(이 PC):  http://localhost:8080
 상태 보기:      http://localhost:8080/__status
 지금 실행:      local\\run-now.bat
 끄기:           local\\stop.bat      /  완전 해제: local\\uninstall-windows.bat
 기록:           local\\logs 폴더
`);
