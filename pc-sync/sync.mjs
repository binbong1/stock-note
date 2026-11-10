// 내 PC에서 실행하는 잔고 동기화 (키움은 등록된 IP에서만 조회되므로 PC에서 실행)
// 1) 키움(필요하면 한국투자증권도) 잔고 조회
// 2) 비밀번호로 암호화
// 3) GitHub 저장소의 data/holdings-local.enc.json 에 업로드
// 4) '주식 데이터 수집' 워크플로를 바로 실행시켜 대시보드 갱신
//
// 실행: node sync.mjs   (같은 폴더의 config.json 을 읽습니다)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKiwoom, fetchKIS, encryptJSON } from './brokers.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
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
  const cfg = JSON.parse(await fs.readFile(path.join(DIR, 'config.json'), 'utf8'));
  if (!cfg.password || cfg.password.length < 8) throw new Error('config.json 의 password 는 8자 이상으로 정해 주세요');

  const items = [];
  for (const [i, k] of (cfg.kiwoom || []).entries()) {
    if (!k.appkey) continue;
    const list = await fetchKiwoom(k);
    items.push(...list);
    log(`키움 계좌 ${i + 1}: ${list.length}종목`);
  }
  if (cfg.kis?.appkey) {
    const list = await fetchKIS(cfg.kis);
    items.push(...list);
    log(`한국투자증권: ${list.length}종목`);
  }

  const box = encryptJSON({ updatedAt: new Date().toISOString(), items }, cfg.password);
  const filePath = '/contents/data/holdings-local.enc.json';
  const cur = await gh(cfg, 'GET', filePath);
  await gh(cfg, 'PUT', filePath, {
    message: 'PC 잔고 동기화',
    content: Buffer.from(JSON.stringify(box)).toString('base64'),
    sha: cur?.sha,
  });
  log('암호화한 잔고를 GitHub에 올렸어요');

  if (cfg.github.runWorkflow !== false) {
    await gh(cfg, 'POST', '/actions/workflows/collect.yml/dispatches', { ref: cfg.github.branch || 'main' });
    log('대시보드 갱신(워크플로)을 요청했어요. 1~2분 뒤 사이트를 새로고침하세요.');
  }
}

main().catch((e) => { log('실패:', e.message); process.exit(1); });
