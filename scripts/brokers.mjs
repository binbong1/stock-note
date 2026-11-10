// 증권사 잔고 조회 + 암호화 도우미 (외부 패키지 없음)
// - 한국투자증권(KIS) Open API: 국내·해외(미국) 잔고
// - 키움증권 REST API: 국내 잔고 (등록된 IP에서만 동작 → 내 PC에서 실행)
// 모든 함수는 '조회'만 하고 주문 기능은 쓰지 않습니다.

import crypto from 'node:crypto';

const num = (v) => {
  const n = Number(String(v ?? '').trim().replace(/,/g, '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : 0;
};

async function call(url, opts, label) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${label}: JSON 아님 (HTTP ${res.status}) ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${json.msg1 || json.return_msg || json.error_description || ''}`);
  return { json, headers: res.headers };
}

// ---------------- 한국투자증권 ----------------
// 필요한 값: appkey, appsecret, account("12345678-01" 형식)
export async function fetchKIS({ appkey, appsecret, account }) {
  const BASE = 'https://openapi.koreainvestment.com:9443';
  const [cano, prdt = '01'] = String(account).replace(/\s/g, '').split('-');
  if (!/^\d{8}$/.test(cano)) throw new Error('KIS 계좌번호는 "12345678-01" 형식이어야 해요');

  const { json: tok } = await call(`${BASE}/oauth2/tokenP`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret }),
  }, 'KIS 토큰');
  if (!tok.access_token) throw new Error('KIS 토큰 발급 실패');
  const H = (trId, trCont = '') => ({
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${tok.access_token}`, appkey, appsecret,
    tr_id: trId, custtype: 'P', tr_cont: trCont,
  });

  const out = [];

  // 국내 잔고 (TTTC8434R) — 50건 넘으면 연속조회
  let fk = '', nk = '', cont = '';
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      CANO: cano, ACNT_PRDT_CD: prdt, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
    });
    const { json, headers } = await call(`${BASE}/uapi/domestic-stock/v1/trading/inquire-balance?${q}`,
      { headers: H('TTTC8434R', cont) }, 'KIS 국내잔고');
    if (json.rt_cd && json.rt_cd !== '0') throw new Error(`KIS 국내잔고: ${json.msg1}`);
    for (const r of json.output1 || []) {
      const qty = num(r.hldg_qty);
      if (qty > 0) out.push({ broker: 'KIS', code: r.pdno, name: r.prdt_name, market: 'KRX', currency: 'KRW', qty, avg: num(r.pchs_avg_pric) });
    }
    const more = ['M', 'F'].includes(headers.get('tr_cont'));
    if (!more) break;
    fk = json.ctx_area_fk100 || ''; nk = json.ctx_area_nk100 || ''; cont = 'N';
    await new Promise((r) => setTimeout(r, 300));
  }

  // 해외(미국) 잔고 (TTTS3012R) — 실전에서 NASD는 미국 전체
  try {
    const q = new URLSearchParams({ CANO: cano, ACNT_PRDT_CD: prdt, OVRS_EXCG_CD: 'NASD', TR_CRCY_CD: 'USD', CTX_AREA_FK200: '', CTX_AREA_NK200: '' });
    const { json } = await call(`${BASE}/uapi/overseas-stock/v1/trading/inquire-balance?${q}`,
      { headers: H('TTTS3012R') }, 'KIS 해외잔고');
    if (json.rt_cd && json.rt_cd !== '0') throw new Error(json.msg1);
    const ex = { NASD: 'NASDAQ', NYSE: 'NYSE', AMEX: 'AMEX' };
    for (const r of json.output1 || []) {
      const qty = num(r.ovrs_cblc_qty);
      if (qty > 0) out.push({ broker: 'KIS', code: r.ovrs_pdno, name: r.ovrs_item_name, market: ex[r.ovrs_excg_cd] || 'NASDAQ', currency: 'USD', qty, avg: num(r.pchs_avg_pric) });
    }
  } catch (e) {
    console.log('[KIS] 해외잔고 건너뜀:', e.message);
  }
  return out;
}

// ---------------- 키움증권 ----------------
// 필요한 값: appkey, secretkey (계좌 App Key 관리에서 계좌별로 발급)
export async function fetchKiwoom({ appkey, secretkey }) {
  const BASE = 'https://api.kiwoom.com';
  const { json: tok } = await call(`${BASE}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, secretkey }),
  }, '키움 토큰');
  if (!tok.token) throw new Error(`키움 토큰 발급 실패: ${tok.return_msg || ''} (PC의 IP가 등록돼 있는지 확인)`);

  const out = [];
  let cont = 'N', next = '';
  for (let page = 0; page < 10; page++) {
    const { json, headers } = await call(`${BASE}/api/dostk/acnt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8', authorization: `Bearer ${tok.token}`,
        'api-id': 'kt00018', 'cont-yn': cont, 'next-key': next,
      },
      body: JSON.stringify({ qry_tp: '1', dmst_stex_tp: 'KRX' }),
    }, '키움 잔고');
    if (json.return_code !== 0 && json.return_code !== '0') throw new Error(`키움 잔고: ${json.return_msg}`);
    for (const r of json.acnt_evlt_remn_indv_tot || []) {
      const qty = num(r.rmnd_qty);
      const code = String(r.stk_cd || '').trim().replace(/^[A-Z]/, ''); // A005930 → 005930
      if (qty > 0 && /^\w{6}$/.test(code)) out.push({ broker: '키움', code, name: String(r.stk_nm || '').trim(), market: 'KRX', currency: 'KRW', qty, avg: num(r.pur_pric) });
    }
    if (headers.get('cont-yn') !== 'Y') break;
    cont = 'Y'; next = headers.get('next-key') || '';
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

// ---------------- 암호화 (브라우저 WebCrypto와 호환) ----------------
// AES-256-GCM, 키는 비밀번호에서 PBKDF2-SHA256(200,000회)로 만듭니다.
const ITER = 200000;

export function encryptJSON(obj, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64') };
}

export function decryptJSON(box, password) {
  const key = crypto.pbkdf2Sync(password, Buffer.from(box.salt, 'base64'), box.iter, 32, 'sha256');
  const buf = Buffer.from(box.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}
