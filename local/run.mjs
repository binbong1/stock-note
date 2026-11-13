// 내 주식 노트 · 윈도우 PC 상시 실행기
//
//   node local/run.mjs daemon        상시 실행 (start.cmd 가 자동으로 켬)
//   node local/run.mjs job <이름>     작업 하나만 바로 실행
//        이름: sync | collect | daily | intraday | news | credit | evening | publish | pull
//   node local/run.mjs mode local     GitHub 자동 실행을 쉬게 하고 이 PC가 맡기
//   node local/run.mjs mode github    다시 GitHub이 맡기
//   node local/run.mjs status         최근 실행 기록 보기
//
// 하는 일 (모두 한국시간, 평일 기준)
//   · 09:00~15:50  10분마다 장중 돌파 감시 (scan intraday)
//   · 07:00~21:45  15분마다 보유 종목 공시·리포트 확인 (news)
//   · 16:10        키움·토스 잔고 → 전체 수집(collect) → 장 마감 스캔(daily) → 신용잔고 그래프
//                  (PC가 꺼져 있었으면 켜진 뒤 그날 밤 12시 전까지 따라잡아 실행)
//   · 텔레그램 봇 상시 실행 (꺼지면 다시 켬)
//   · http://localhost:8080 에서 사이트 열기
//   · 바뀐 데이터는 5분마다 GitHub에 올려 휴대폰 사이트(GitHub Pages)에도 반영
//   · 매일 새벽 6시 GitHub에서 새 코드 받아오기 (바뀌면 스스로 다시 시작)

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'local', 'config.json');
const STATE_FILE = path.join(ROOT, 'local', 'state.json');
const LOG_DIR = path.join(ROOT, 'local', 'logs');
const EXIT_ALREADY = 9; // start.cmd 가 이 코드를 보면 다시 켜지 않음
const EXIT_UPDATED = 3;

const kst = () => new Date(Date.now() + 9 * 3600000);
const kstDate = () => kst().toISOString().slice(0, 10);
const kstHM = () => { const d = kst(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const isWeekday = () => { const w = kst().getUTCDay(); return w >= 1 && w <= 5; };
const stamp = () => kst().toISOString().replace('T', ' ').slice(0, 19);

await fs.mkdir(LOG_DIR, { recursive: true });
function log(...a) {
  const line = `${stamp()} | ${a.join(' ')}`;
  console.log(line);
  try { fss.appendFileSync(path.join(LOG_DIR, `${kstDate()}.log`), line + '\n'); } catch {}
}

async function loadConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')); }
  catch { console.error('local\\config.json 이 없어요. 먼저 install-windows.bat 을 실행하세요.'); process.exit(1); }
}
const CFG = await loadConfig();

let STATE = {};
try { STATE = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch {}
const saveState = () => fs.writeFile(STATE_FILE, JSON.stringify(STATE, null, 2)).catch(() => {});

// ---------------------------------------------------------------- 실행 환경
function scriptEnv() {
  // 설정을 바꾸면(local\\setup.mjs) 다시 켜지 않아도 다음 작업부터 반영
  try { Object.assign(CFG, JSON.parse(fss.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
  const env = { ...process.env, HOLDINGS_PASSWORD: CFG.password, DART_API_KEY: CFG.dart || '', STOCKNOTE_LOCAL: '1', STOCKNOTE_CONFIG: CONFIG_FILE };
  (CFG.kisAccounts || []).forEach((k, i) => {
    const sfx = i === 0 ? '' : `_${i + 1}`;
    env[`KIS_APPKEY${sfx}`] = k.appkey; env[`KIS_APPSECRET${sfx}`] = k.appsecret; env[`KIS_ACCOUNT${sfx}`] = k.account;
  });
  if (CFG.telegram?.token) { env.TELEGRAM_BOT_TOKEN = CFG.telegram.token; env.TELEGRAM_CHAT_ID = String(CFG.telegram.chatId); }
  if (CFG.siteUrl) env.SITE_URL = CFG.siteUrl;
  return env;
}

function run(cmd, args, { timeoutMin = 30, quiet = false, env } = {}) {
  return new Promise((resolve) => {
    const out = [];
    const p = spawn(cmd, args, { cwd: ROOT, env: env || scriptEnv(), windowsHide: true });
    const onData = (d) => { const t = d.toString(); out.push(t); if (!quiet) for (const l of t.split(/\r?\n/)) if (l.trim()) log('   ', l); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    const timer = setTimeout(() => { log(`   ⏱ ${timeoutMin}분이 지나 멈췄어요`); p.kill(); }, timeoutMin * 60000);
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.join('') }); });
  });
}
const node = (args, o) => run(process.execPath, args, o);
const git = (args, o = {}) => run('git', args, { quiet: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...o });
// 받아오다 충돌이 나면 되돌리고, 이 PC의 데이터를 우선으로 다시 시도 (저장소가 꼬인 채로 남지 않게)
async function safePull(remote, branch) {
  let r = await git(['pull', '--rebase', '--autostash', '-q', remote, branch]);
  if (r.code === 0) return r;
  await git(['rebase', '--abort']);
  r = await git(['pull', '--rebase', '--autostash', '-X', 'theirs', '-q', remote, branch]);
  if (r.code !== 0) await git(['rebase', '--abort']);
  return r;
}

// 인터넷이 끊긴 채로 수집하면 빈 데이터로 덮어쓸 수 있어서, 먼저 확인
async function online() {
  try { const r = await fetch('https://m.stock.naver.com/', { method: 'HEAD', signal: AbortSignal.timeout(8000) }); return r.status < 500; }
  catch { return false; }
}
const NEEDS_NET = new Set(['sync', 'collect', 'daily', 'intraday', 'news', 'credit', 'evening']);

// ---------------------------------------------------------------- 작업
const JOBS = {
  async sync() { return node(['pc-sync/sync.mjs', '--local'], { timeoutMin: 15 }); },
  async collect() { return node(['scripts/collect.mjs'], { timeoutMin: 15 }); },
  async daily() { return node(['scripts/scan.mjs', 'daily'], { timeoutMin: 25 }); },
  async intraday() { return node(['scripts/scan.mjs', 'intraday'], { timeoutMin: 9 }); },
  async news() { return node(['scripts/news.mjs'], { timeoutMin: 10 }); },
  async credit() { return node(['scripts/credit.mjs'], { timeoutMin: 5 }); },
  async evening() {
    const a = await JOBS.sync();
    const b = await JOBS.collect();
    await JOBS.publish(); // 잔고·시세는 스캔을 기다리지 않고 먼저 사이트에 반영
    const c = await JOBS.daily();
    await JOBS.credit();  // 신용잔고 그래프 (금융투자협회 자료가 새로 나왔을 때만)
    await JOBS.publish();
    return { code: [a, b, c].some((r) => r.code !== 0) ? 1 : 0 };
  },
  async pull() {
    const before = START_HEAD || (await git(['rev-parse', 'HEAD'])).out.trim();
    const r = await safePull('origin', CFG.github?.branch || 'main');
    if (r.code !== 0) { log('   GitHub에서 받아오기 실패:', r.out.trim().split('\n').slice(-2).join(' ')); return r; }
    const after = (await git(['rev-parse', 'HEAD'])).out.trim();
    if (before !== after) {
      const changed = (await git(['diff', '--name-only', before, after])).out;
      if (/^(scripts|pc-sync|local|index\.html)/m.test(changed)) { log('   새 코드를 받았어요 → 다시 시작해요'); r.codeUpdated = true; }
    }
    return r;
  },
  async publish() {
    if (!CFG.github?.token) return { code: 0 };
    const st = await git(['status', '--porcelain', '--', 'data', 'config']);
    // 바뀐 게 없고 지난번에 못 올린 것도 없으면 끝 (못 올린 커밋은 다음번에 꼭 다시 올림)
    if (!st.out.trim() && !STATE.needPush) return { code: 0 };
    if (st.out.trim()) {
      await git(['add', '--', 'data', 'config']);
      const c = await git(['-c', 'user.name=stock-note-pc', '-c', 'user.email=stock-note-pc@users.noreply.github.com', 'commit', '-q', '-m', `PC 데이터 업데이트 ${stamp().slice(0, 16)}`]);
      if (c.code !== 0 && !/nothing to commit/.test(c.out)) { log('   커밋 실패:', c.out.trim().slice(0, 300)); return c; }
    }
    STATE.needPush = true; await saveState();
    const { owner, repo, token, branch = 'main' } = CFG.github;
    const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const hide = (t) => String(t).replaceAll(token, '***').trim().slice(0, 300);
    for (let i = 0; i < 3; i++) {
      const pl = await safePull(url, branch);
      if (pl.code !== 0) log('   GitHub에서 받아오기 실패:', hide(pl.out));
      const p = await git(['push', '-q', url, `HEAD:${branch}`]);
      if (p.code === 0) { STATE.needPush = false; await saveState(); log('   GitHub에 올렸어요 (휴대폰 사이트 반영)'); return p; }
      log('   GitHub 올리기 실패, 다시 시도:', hide(p.out));
      await new Promise((r) => setTimeout(r, 5000));
    }
    return { code: 1 };
  },
};

let START_HEAD = null; // 켜질 때의 코드 버전 (직접 git pull 해도 새벽에 새 코드로 다시 시작)

// 작업은 한 번에 하나씩 (같은 파일을 동시에 고치지 않게)
const queue = [];
let busy = null;
function enqueue(name, why = '') {
  if (busy === name || queue.includes(name)) return;
  queue.push(name);
  pump();
}
async function pump() {
  if (busy || !queue.length) return;
  busy = queue.shift();
  const t0 = Date.now();
  log(`▶ ${busy} 시작`);
  let r;
  if (NEEDS_NET.has(busy) && !(await online())) {
    log('   인터넷(네이버 증권)에 연결이 안 돼서 건너뛰어요');
    r = { code: 2 };
    if (busy === 'evening') { STATE.slots.evening = null; STATE.eveningRetryAt = Date.now() + 10 * 60000; log('   장 마감 작업은 10분 뒤 다시 시도해요'); }
  } else {
    try { r = await JOBS[busy](); } catch (e) { r = { code: 1 }; log('   오류:', e.message); }
  }
  const sec = Math.round((Date.now() - t0) / 1000);
  log(`${r.code === 0 ? '✔' : '✖'} ${busy} 끝 (${sec}초)`);
  STATE.last = STATE.last || {};
  STATE.last[busy] = { at: stamp(), ok: r.code === 0, sec };
  await saveState();
  const name = busy; busy = null;
  if (name === 'pull' && r.codeUpdated) { await shutdown(EXIT_UPDATED); return; }
  pump();
}

// ---------------------------------------------------------------- 시간표
const EVENING_AT = 16 * 60 + 10;
let cfgMtime = 0;
function tick() {
  // 설정 파일이 바뀌면 봇을 다시 켜서 새 설정(예: Claude API 키)을 읽게 함
  try {
    const mt = fss.statSync(CONFIG_FILE).mtimeMs;
    if (cfgMtime && mt !== cfgMtime) {
      if (bot) { log('설정이 바뀌어서 봇을 다시 켜요'); bot.kill(); }
      // 키를 새로 넣었으면 오늘 장 마감 작업(잔고 수집)을 한 번 더 해서 바로 반영
      if (STATE.slots?.evening) { log('설정이 바뀌어서 잔고를 다시 가져와요'); STATE.slots.evening = null; STATE.eveningRetryAt = 0; }
    }
    cfgMtime = mt;
  } catch {}
  const m = kstHM(), d = kstDate(), wd = isWeekday();
  STATE.slots = STATE.slots || {};
  const once = (key) => { if (STATE.slots[key] === d) return false; STATE.slots[key] = d; saveState(); return true; };
  const every = (key, min) => { const slot = `${d} ${Math.floor(m / min)}`; if (STATE.slots[key] === slot) return false; STATE.slots[key] = slot; return true; };

  if (wd && m >= 9 * 60 && m < 15 * 60 + 55 && every('intraday', 10)) enqueue('intraday');
  if (wd && m >= 7 * 60 && m < 22 * 60 && every('news', 15)) enqueue('news');
  if (wd && m >= EVENING_AT && Date.now() >= (STATE.eveningRetryAt || 0) && once('evening')) enqueue('evening');
  if (m >= 6 * 60 && once('pull')) enqueue('pull');
  if (every('publish', 5)) enqueue('publish');
}

// ---------------------------------------------------------------- 텔레그램 봇 (상시)
let bot = null, stopping = false;
function startBot() {
  if (!CFG.telegram?.token || CFG.bot === false || stopping) return;
  const bl = path.join(LOG_DIR, 'bot.log');
  try { if (fss.statSync(bl).size > 5e6) fss.renameSync(bl, bl + '.old'); } catch {}
  log('🤖 텔레그램 봇 켜기');
  const out = fss.openSync(path.join(LOG_DIR, 'bot.log'), 'a');
  bot = spawn(process.execPath, ['pc-sync/bot.mjs'], { cwd: ROOT, env: scriptEnv(), windowsHide: true, stdio: ['ignore', out, out] });
  bot.on('exit', (code) => {
    bot = null;
    if (stopping) return;
    log(`🤖 봇이 꺼졌어요 (코드 ${code}) → 다시 켜요`);
    setTimeout(startBot, code == null ? 3000 : 20000);
  });
}

// ---------------------------------------------------------------- 내 PC에서 사이트 열기
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const BLOCK = /^\/(local|pc-sync|\.git|\.github|scripts)(\/|$)/i;
function startServer(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (p === '/__status') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ now: stamp(), busy, queue, bot: !!bot, last: STATE.last || {} }, null, 2));
      }
      if (p === '/__log') {
        // 오늘 기록 마지막 150줄 (토큰·키는 기록에 남기지 않음)
        let t = '';
        try { t = (await fs.readFile(path.join(LOG_DIR, `${kstDate()}.log`), 'utf8')).split('\n').slice(-150).join('\n'); } catch {}
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(t || '오늘 기록이 없어요');
      }
      if (p === '/__run' && req.socket.remoteAddress?.includes('127.0.0.1')) {
        const j = url.searchParams.get('job');
        if (JOBS[j]) { enqueue(j); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(`${j} 실행을 예약했어요`); }
      }
      if (p === '/__stop' && req.socket.remoteAddress?.includes('127.0.0.1')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('끄는 중이에요');
        return shutdown(EXIT_ALREADY);
      }
      if (p.endsWith('/')) p += 'index.html';
      if (BLOCK.test(p) || p.includes('..')) { res.writeHead(404); return res.end(); }
      try {
        const body = await fs.readFile(path.join(ROOT, p));
        res.writeHead(200, { 'content-type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end('없음'); }
    });
    srv.once('error', reject);
    srv.listen(port, CFG.server?.host || '127.0.0.1', () => resolve(srv));
  });
}

async function shutdown(code) {
  stopping = true;
  log('■ 끄는 중');
  if (bot) bot.kill();
  setTimeout(() => process.exit(code), 1500);
}

// ---------------------------------------------------------------- 명령
async function setMode(mode) {
  const f = path.join(ROOT, 'config', 'runner.json');
  const j = { _설명: 'mode 가 local 이면 GitHub 자동 실행은 쉬고 윈도우 PC가 모든 작업을 해요. github 로 바꾸면 다시 GitHub이 실행해요.', mode };
  await fs.writeFile(f, JSON.stringify(j, null, 2) + '\n');
  await JOBS.publish();
  log(mode === 'local' ? '이제 이 PC가 모든 작업을 맡아요 (GitHub 자동 실행은 쉼)' : '다시 GitHub이 자동 실행해요');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'job') {
  if (!JOBS[arg]) { console.log('작업 이름: ' + Object.keys(JOBS).join(' | ')); process.exit(1); }
  if (NEEDS_NET.has(arg) && !(await online())) { log('인터넷(네이버 증권)에 연결이 안 돼요. 연결을 확인해 주세요.'); process.exit(1); }
  log(`▶ ${arg} (직접 실행)`);
  const r = await JOBS[arg]();
  if (['sync', 'collect', 'daily', 'intraday', 'news', 'credit'].includes(arg)) await JOBS.publish();
  log(r.code === 0 ? '✔ 끝' : '✖ 실패 — 위 메시지를 확인하세요');
  process.exit(r.code === 0 ? 0 : 1);
} else if (cmd === 'mode') {
  if (!['local', 'github'].includes(arg)) { console.log('사용법: node local/run.mjs mode local|github'); process.exit(1); }
  await setMode(arg);
} else if (cmd === 'stop' || cmd === 'uninstall') {
  const port = CFG.server?.port || 8080;
  try { await fetch(`http://127.0.0.1:${port}/__stop`); console.log('껐어요.'); } catch { console.log('실행 중이 아니었어요.'); }
  if (cmd === 'uninstall') {
    await fs.rm(path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'StockNote.vbs'), { force: true });
    await setMode('github');
    console.log('자동 실행을 지웠고, 다시 GitHub이 자동 실행하도록 바꿨어요.');
  } else console.log('다시 켜려면 PC를 재시작하거나 local\\start.cmd 를 더블클릭하세요.');
} else if (cmd === 'now') {
  const port = CFG.server?.port || 8080;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n 1) 장 마감 작업 전체 (키움/토스 잔고 + 한투 + 수집 + 스캔)\n 2) 공시/리포트 확인\n 3) 장중 돌파 감시\n 4) GitHub 사이트에 바로 올리기\n');
  const n = (await rl.question('번호를 고르세요: ')).trim(); rl.close();
  const job = { 1: 'evening', 2: 'news', 3: 'intraday', 4: 'publish' }[n];
  if (!job) process.exit(0);
  try { console.log((await (await fetch(`http://127.0.0.1:${port}/__run?job=${job}`)).text())); console.log(`진행 상황: http://localhost:${port}/__status  (기록: local\\logs 폴더)`); }
  catch { console.log('상시 실행이 꺼져 있어서 지금 이 창에서 실행해요...'); const r = await JOBS[job](); if (job !== 'publish') await JOBS.publish(); console.log(r.code === 0 ? '✔ 끝' : '✖ 실패 — 위 메시지를 확인하세요'); }
} else if (cmd === 'status') {
  console.log(JSON.stringify(STATE.last || {}, null, 2));
} else if (cmd === 'daemon') {
  const port = CFG.server?.port || 8080;
  try { await startServer(port); }
  catch (e) {
    if (e.code === 'EADDRINUSE') { log(`이미 실행 중이에요 (포트 ${port} 사용 중)`); process.exit(EXIT_ALREADY); }
    throw e;
  }
  START_HEAD = (await git(['rev-parse', 'HEAD'])).out.trim() || null;
  log(`● 시작 — 사이트: http://localhost:${port}  (상태: http://localhost:${port}/__status)`);
  try {
    const runner = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'runner.json'), 'utf8'));
    if (runner.mode !== 'local') { log('GitHub 자동 실행을 쉬게 바꿔요 (중복 알림 방지)'); await setMode('local'); }
  } catch { await setMode('local'); }
  startBot();
  tick();
  setInterval(tick, 30000);
  process.on('SIGINT', () => shutdown(EXIT_ALREADY));
} else {
  console.log(fss.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
