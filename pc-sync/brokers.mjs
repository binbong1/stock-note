// 증권사 잔고·실현손익 조회 + 암호화 도우미 (외부 패키지 없음)
// - 한국투자증권(KIS) Open API: 국내·해외(미국) 잔고, 국내 기간별 매매손익
// - 키움증권 REST API: 국내 잔고, 일자별 실현손익 (등록된 IP에서만 동작 → 내 PC에서 실행)
// 모든 함수는 '조회'만 하고 주문 기능은 쓰지 않습니다.

import crypto from 'node:crypto';

const num = (v) => {
  const n = Number(String(v ?? '').trim().replace(/,/g, '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : 0;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const dash = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const mask = (acct) => { const [a, b = ''] = String(acct).split('-'); return `****${a.slice(-4)}${b ? '-' + b : ''}`; };

async function call(url, opts, label) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${label}: JSON 아님 (HTTP ${res.status}) ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${json.msg1 || json.return_msg || json.error_description || ''}`);
  return { json, headers: res.headers };
}

// ======================= 한국투자증권 =======================
const KIS_BASE = 'https://openapi.koreainvestment.com:9443';
const kisClients = new Map();

// 토큰은 1분에 1번만 발급되므로 같은 실행 안에서는 재사용
async function kisClient({ appkey, appsecret, account }) {
  if (kisClients.has(appkey)) return kisClients.get(appkey);
  const [cano, prdt = '01'] = String(account).replace(/\s/g, '').split('-');
  if (!/^\d{8}$/.test(cano)) throw new Error('KIS 계좌번호는 "12345678-01" 형식이어야 해요');
  // 토큰은 1분에 1번만 발급됨 → 제한에 걸리면 65초 기다렸다가 최대 2번 더 시도
  let tok;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ json: tok } = await call(`${KIS_BASE}/oauth2/tokenP`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret }),
      }, 'KIS 토큰'));
      break;
    } catch (e) {
      if (attempt < 2 && /1분당|EGW00133/.test(e.message)) { console.log('[KIS] 토큰 발급 제한 → 65초 후 재시도'); await sleep(65000); continue; }
      throw e;
    }
  }
  if (!tok.access_token) throw new Error('KIS 토큰 발급 실패');
  // 호출 간격을 0.7초 이상 두고, '초당 거래건수 초과'면 잠시 쉬었다가 최대 6번 재시도
  // (신규 발급 키는 처음 며칠 동안 초당 허용 건수가 낮음)
  let lastAt = 0;
  const get = async (path, trId, params, trCont = '') => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + 700 - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      try {
        const { json, headers } = await call(`${KIS_BASE}${path}?${new URLSearchParams(params)}`, {
          headers: {
            'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${tok.access_token}`,
            appkey, appsecret, tr_id: trId, custtype: 'P', tr_cont: trCont,
          },
        }, `KIS ${trId}`);
        if (json.rt_cd && json.rt_cd !== '0') throw new Error(`KIS ${trId}: ${json.msg1}`);
        return { json, more: ['M', 'F'].includes(headers.get('tr_cont')) };
      } catch (e) {
        if (attempt < 6 && /초당|EGW00201|거래건수/.test(e.message)) { await sleep(1500 * (attempt + 1)); continue; }
        throw e;
      }
    }
  };
  const c = { cano, prdt, label: mask(`${cano}-${prdt}`), get };
  kisClients.set(appkey, c);
  return c;
}

// 잔고: { items: 보유종목[], accounts: [{예수금·총평가}] }
export async function fetchKIS(cfg) {
  const c = await kisClient(cfg);
  const items = [], account = { broker: 'KIS', account: c.label, cash: null, total: null };

  let fk = '', nk = '', cont = '';
  for (let page = 0; page < 10; page++) {
    const { json, more } = await c.get('/uapi/domestic-stock/v1/trading/inquire-balance', 'TTTC8434R', {
      CANO: c.cano, ACNT_PRDT_CD: c.prdt, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
    }, cont);
    for (const r of json.output1 || []) {
      const qty = num(r.hldg_qty);
      if (qty > 0) items.push({ broker: 'KIS', account: c.label, code: r.pdno, name: r.prdt_name, market: 'KRX', currency: 'KRW', qty, avg: num(r.pchs_avg_pric) });
    }
    const sum = Array.isArray(json.output2) ? json.output2[0] : json.output2;
    if (sum && page === 0) { account.cash = num(sum.dnca_tot_amt); account.total = num(sum.tot_evlu_amt); }
    if (!more) break;
    fk = json.ctx_area_fk100 || ''; nk = json.ctx_area_nk100 || ''; cont = 'N';
    await sleep(300);
  }

  try {
    const { json } = await c.get('/uapi/overseas-stock/v1/trading/inquire-balance', 'TTTS3012R', {
      CANO: c.cano, ACNT_PRDT_CD: c.prdt, OVRS_EXCG_CD: 'NASD', TR_CRCY_CD: 'USD', CTX_AREA_FK200: '', CTX_AREA_NK200: '',
    });
    const ex = { NASD: 'NASDAQ', NYSE: 'NYSE', AMEX: 'AMEX' };
    for (const r of json.output1 || []) {
      const qty = num(r.ovrs_cblc_qty);
      if (qty > 0) items.push({ broker: 'KIS', account: c.label, code: r.ovrs_pdno, name: r.ovrs_item_name, market: ex[r.ovrs_excg_cd] || 'NASDAQ', currency: 'USD', qty, avg: num(r.pchs_avg_pric) });
    }
  } catch (e) {
    console.log('[KIS] 해외잔고 건너뜀:', e.message);
  }
  return { items, accounts: [account] };
}

// 종목별 투자자(외국인·기관) 순매수 최근 일자별 (FHKST01010900). 최근 n일 합계를 돌려줌
export async function fetchKISInvestor(cfg, code, days = 20) {
  const c = await kisClient(cfg);
  const { json } = await c.get('/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900', {
    FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
  });
  const rows = (json.output || []).filter((r) => r.stck_bsop_date).slice(0, days);
  return {
    days: rows.length,
    foreign: rows.reduce((t, r) => t + num(r.frgn_ntby_qty), 0),
    institution: rows.reduce((t, r) => t + num(r.orgn_ntby_qty), 0),
  };
}

// 국내 기간별 매매손익(TTTC8715R): 매도한 거래의 실현손익. 한 달 단위로 나눠 조회.
export async function fetchKISRealized(cfg, fromYmd, toYmd) {
  const c = await kisClient(cfg);
  const rows = [];
  let start = new Date(`${dash(fromYmd)}T00:00:00Z`);
  const end = new Date(`${dash(toYmd)}T00:00:00Z`);
  while (start <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getTime()));
    let fk = '', nk = '', cont = '';
    for (let page = 0; page < 20; page++) {
      const { json, more } = await c.get('/uapi/domestic-stock/v1/trading/inquire-period-trade-profit', 'TTTC8715R', {
        CANO: c.cano, ACNT_PRDT_CD: c.prdt, SORT_DVSN: '01', PDNO: '', INQR_STRT_DT: ymd(start), INQR_END_DT: ymd(chunkEnd),
        CBLC_DVSN: '00', CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
      }, cont);
      for (const r of json.output1 || []) {
        const qty = num(r.sll_qty);
        if (!qty || !r.trad_dt) continue;
        rows.push({
          date: dash(r.trad_dt), broker: 'KIS', account: c.label, code: r.pdno, name: r.prdt_name,
          qty, sellAmt: num(r.sll_amt), buyPrice: num(r.pchs_unpr), pl: num(r.rlzt_pfls), rate: num(r.pfls_rt),
          fee: num(r.fee), tax: num(r.tl_tax),
        });
      }
      if (!more) break;
      fk = json.ctx_area_fk100 || ''; nk = json.ctx_area_nk100 || ''; cont = 'N';
    }
    start = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }
  return { account: c.label, rows };
}

// ======================= 키움증권 =======================
const KW_BASE = 'https://api.kiwoom.com';
const kwClients = new Map();

async function kiwoomClient({ appkey, secretkey }, index = 0) {
  if (kwClients.has(appkey)) return kwClients.get(appkey);
  const { json: tok } = await call(`${KW_BASE}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, secretkey }),
  }, '키움 토큰');
  if (!tok.token) throw new Error(`키움 토큰 발급 실패: ${tok.return_msg || ''} (PC의 IP가 등록돼 있는지 확인)`);
  const post = async (apiId, body, cont = 'N', next = '', urlPath = '/api/dostk/acnt') => {
    const { json, headers } = await call(`${KW_BASE}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8', authorization: `Bearer ${tok.token}`,
        'api-id': apiId, 'cont-yn': cont, 'next-key': next,
      },
      body: JSON.stringify(body),
    }, `키움 ${apiId}`);
    if (json.return_code !== 0 && json.return_code !== '0') {
      // 거래가 없는 날은 오류 코드로 '조회내역이 없습니다'가 옴 → 빈 결과로 처리
      if (/조회내역이 없|조회할 내역이 없|571758/.test(String(json.return_msg))) return { json: {}, more: false, next: '' };
      throw new Error(`키움 ${apiId}: ${json.return_msg}`);
    }
    return { json, more: headers.get('cont-yn') === 'Y', next: headers.get('next-key') || '' };
  };
  const c = { label: `키움 계좌 ${index + 1}`, post };
  kwClients.set(appkey, c);
  return c;
}

export async function fetchKiwoom(cfg, index = 0) {
  const c = await kiwoomClient(cfg, index);
  const items = [], account = { broker: '키움', account: c.label, cash: null, total: null };
  let cont = 'N', next = '';
  for (let page = 0; page < 10; page++) {
    const r = await c.post('kt00018', { qry_tp: '1', dmst_stex_tp: 'KRX' }, cont, next);
    for (const x of r.json.acnt_evlt_remn_indv_tot || []) {
      const qty = num(x.rmnd_qty);
      const code = String(x.stk_cd || '').trim().replace(/^[A-Z]/, '');
      if (qty > 0 && /^\w{6}$/.test(code)) items.push({ broker: '키움', account: c.label, code, name: String(x.stk_nm || '').trim(), market: 'KRX', currency: 'KRW', qty, avg: num(x.pur_pric) });
    }
    if (page === 0) {
      const asset = num(r.json.prsm_dpst_aset_amt), evlt = num(r.json.tot_evlt_amt);
      if (asset) { account.total = asset; account.cash = Math.max(0, asset - evlt); }
    }
    if (!r.more) break;
    cont = 'Y'; next = r.next;
    await sleep(300);
  }
  return { items, accounts: [account] };
}

// 일자별 실현손익(ka10073)을 하루씩 조회 → 날짜가 확실하게 붙음
export async function fetchKiwoomRealized(cfg, days, index = 0) {
  const c = await kiwoomClient(cfg, index);
  const rows = [];
  for (const day of days) {
    let cont = 'N', next = '';
    for (let page = 0; page < 10; page++) {
      const r = await c.post('ka10073', { strt_dt: day, end_dt: day, stk_cd: '' }, cont, next);
      for (const x of r.json.dt_stk_rlzt_pl || []) {
        const qty = num(x.cntr_qty);
        if (!qty) continue;
        rows.push({
          date: dash(day), broker: '키움', account: c.label,
          code: String(x.stk_cd || '').trim().replace(/^[A-Z]/, ''), name: String(x.stk_nm || '').trim(),
          qty, sellAmt: qty * num(x.cntr_pric), buyPrice: num(x.buy_uv), pl: num(x.tdy_sel_pl), rate: num(x.pl_rt),
          fee: num(x.tdy_trde_cmsn) + num(x.tdy_htssel_cmsn), tax: num(x.tdy_trde_tax),
        });
      }
      if (!r.more) break;
      cont = 'Y'; next = r.next;
      await sleep(220);
    }
    await sleep(220);
  }
  return { account: c.label, rows };
}

// ----- 키움 미국주식 (공식 명세: /api/us/acnt · ust21070 잔고, ust21120 예수금, ust21640 일별 종목별 실현손익) -----
export async function fetchKiwoomUS(cfg, index = 0) {
  const c = await kiwoomClient(cfg, index);
  const label = `${c.label} (해외)`;
  const items = [], account = { broker: '키움', account: label, cash: null, total: null };
  let cont = 'N', next = '';
  for (let page = 0; page < 10; page++) {
    const r = await c.post('ust21070', { stex_tp: '', stk_cd: '' }, cont, next, '/api/us/acnt');
    for (const x of r.json.result_list || []) {
      const qty = num(x.poss_qty);
      const code = String(x.stk_cd || '').trim();
      if (qty > 0 && code) items.push({ broker: '키움', account: label, code, name: String(x.frgn_stk_nm || code).trim(), market: 'US', currency: String(x.crnc_code || 'USD').trim() || 'USD', qty, avg: num(x.frgn_stk_book_uv) });
    }
    if (!r.more) break;
    cont = 'Y'; next = r.next;
    await sleep(300);
  }
  try {
    const r = await c.post('ust21120', { cmsn_incl_tp: '', exrt_tp: '' }, 'N', '', '/api/us/acnt');
    const fxCash = (r.json.result_list || []).reduce((t, x) => t + num(x.chg_entr), 0);
    account.cash = num(r.json.won_entr) + fxCash;
    account.total = num(r.json.aset_evlt_amt) || null;
  } catch (e) { console.log(`[키움 계좌 ${index + 1}] 해외 예수금 조회 건너뜀: ${e.message}`); }
  return { items: items.filter((h) => h.currency === 'USD'), accounts: [account] };
}

// 하루씩 조회. 금액은 응답의 환율(exch_rate)로 원화 환산해서 저장
export async function fetchKiwoomUSRealized(cfg, days, index = 0) {
  const c = await kiwoomClient(cfg, index);
  const label = `${c.label} (해외)`;
  const rows = [];
  for (const day of days) {
    let cont = 'N', next = '';
    for (let page = 0; page < 10; page++) {
      const r = await c.post('ust21640', { stex_tp: '', stk_cd: '', cntr_dt: day, fc_krw_tp: '0' }, cont, next, '/api/us/acnt');
      for (const x of r.json.result_list || []) {
        const qty = num(x.cntr_sellq);
        if (!qty) continue;
        const fx = num(x.exch_rate) || 1;
        rows.push({
          date: dash(day), broker: '키움', account: label, currency: String(x.crnc_code || 'USD').trim(),
          code: String(x.stk_cd || '').trim(), name: String(x.stk_nm || x.stk_cd || '').trim(),
          qty, sellAmt: Math.round(qty * num(x.cntr_sella) * fx), buyPrice: Math.round(num(x.avg_buy_uv) * fx),
          pl: Math.round(num(x.pl_amt) * fx), rate: num(x.pl_rt), fee: Math.round(num(x.cmsn) * fx), tax: Math.round(num(x.altx) * fx),
          usd: { sellPrice: num(x.cntr_sella), buyPrice: num(x.avg_buy_uv), pl: num(x.pl_amt), fx },
        });
      }
      if (!r.more) break;
      cont = 'Y'; next = r.next;
      await sleep(220);
    }
    await sleep(220);
  }
  return { account: label, rows };
}

// 조회 기간의 날짜 목록 (YYYYMMDD). 기본은 평일, includeSat 이면 토요일도 포함(미국장 시차 대비)
export function weekdays(fromDate, toDate, includeSat = false) {
  const out = [];
  for (let d = new Date(fromDate); d <= toDate; d = new Date(d.getTime() + 86400000)) {
    const w = d.getUTCDay();
    if (w !== 0 && (w !== 6 || includeSat)) out.push(ymd(d));
  }
  return out;
}

// ======================= 토스증권 (Open API, 등록한 IP에서만 → 내 PC에서 실행) =======================
// 공식 명세: POST /oauth2/token(form), GET /api/v1/accounts, GET /api/v1/holdings, GET /api/v1/buying-power
// 토스는 실현손익 API가 없어 잔고만 가져옵니다. 금액·수량은 문자열로 옴.
const TOSS = 'https://openapi.tossinvest.com';
const pickAmt = (v) => (v && typeof v === 'object' ? { krw: v.krw != null ? num(v.krw) : null, usd: v.usd != null ? num(v.usd) : null } : v == null ? null : num(v));
export async function fetchToss({ clientId, clientSecret }, index = 0) {
  const tr = await fetch(`${TOSS}/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const tok = await tr.json().catch(() => ({}));
  if (!tok.access_token) throw new Error(`토스 토큰 발급 실패 (HTTP ${tr.status} ${tok.error_description || tok.message || tok.code || ''}) — 허용 IP에 이 PC의 IP가 등록돼 있는지 확인`);
  const H = (seq) => ({ Authorization: `Bearer ${tok.access_token}`, ...(seq != null ? { 'X-Tossinvest-Account': String(seq) } : {}) });
  const get = async (p, seq) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${TOSS}${p}`, { headers: H(seq) });
      if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`토스 ${p}: HTTP ${res.status} ${j.code || j.message || ''}`);
      return j.result ?? j;
    }
    throw new Error(`토스 ${p}: 호출 한도 초과`);
  };
  const accRes = await get('/api/v1/accounts');
  const accs = (Array.isArray(accRes) ? accRes : accRes.accounts || accRes.items || []).filter((a) => !a.accountType || a.accountType === 'BROKERAGE');
  const items = [], accounts = [];
  for (const [k, a] of accs.entries()) {
    const label = accs.length > 1 ? `토스 계좌 ${index + 1}-${k + 1}` : `토스 계좌 ${index + 1}`;
    await sleep(1100);
    const h = await get('/api/v1/holdings', a.accountSeq);
    for (const x of h.items || []) {
      const qty = num(x.quantity);
      if (!qty) continue;
      items.push({
        broker: '토스', account: label, code: String(x.symbol), name: x.name || String(x.symbol),
        market: x.marketCountry === 'US' ? 'US' : 'KRX', currency: x.currency || (x.marketCountry === 'US' ? 'USD' : 'KRW'),
        qty, avg: num(x.averagePurchasePrice), self: true, price: num(x.lastPrice),
        rawValue: pickAmt(x.marketValue?.amount), rawCost: pickAmt(x.marketValue?.purchaseAmount),
        dailyRate: x.dailyProfitLoss?.rate != null ? num(x.dailyProfitLoss.rate) * 100 : null,
      });
    }
    let cash = null;
    try {
      await sleep(300);
      const bp = await get('/api/v1/buying-power?currency=KRW', a.accountSeq);
      const cand = typeof bp === 'object' ? (bp.buyingPower ?? bp.amount ?? bp.orderableAmount ?? bp.cashBuyingPower ?? Object.values(bp).find((v) => /^-?[\d.]+$/.test(String(v)))) : bp;
      cash = cand != null ? num(typeof cand === 'object' ? cand.krw ?? cand.amount : cand) : null;
    } catch (e) { console.log('[토스] 매수가능금액 조회 건너뜀:', e.message); }
    accounts.push({ broker: '토스', account: label, cash, total: null });
  }
  return { items, accounts };
}

// ======================= 암호화 (브라우저 WebCrypto와 호환) =======================
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
