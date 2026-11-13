// 텔레그램 봇 자연어 처리 — Claude API(tool use)로 말뜻을 알아듣고 봇 기능을 골라 실행
// · 조회·분석은 바로 답하고, 설정을 바꾸는 일은 "네"라고 확인받은 뒤에만 실행
// · 주문(매수·매도) 기능은 아예 없음 — 증권사 주문 API를 부르는 코드가 이 프로그램에 없어요
// 설정: config.json 의 "claude": { "apiKey": "sk-ant-...", "model": "claude-haiku-5-5" }

const API = 'https://api.anthropic.com/v1/messages';
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const cap = (s, n = 9000) => (s.length > n ? s.slice(0, n) + '\n…(생략)' : s);
const YES = /^(네|넵|예|응|ㅇㅇ|ㅇ|그래|좋아|해줘|해|확인|ok|okay|yes|y)[\s.!요]*$/i;
const NO = /^(아니|아니요|아니오|ㄴㄴ|ㄴ|취소|하지마|no|n)[\s.!요]*$/i;

const PERIODS = ['오늘', '이번주', '이번달', '지난달', '올해', '1개월', '3개월', '6개월', '1년', '전체'];

function toolDefs(criteriaKeys) {
  const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required });
  return [
    // ---- 조회 (바로 실행)
    { name: 'get_status', description: '총자산, 계좌별 평가금액·손익·오늘 손익, 예수금. detail=true 면 계좌별 보유 종목까지.', input_schema: obj({ detail: { type: 'boolean' } }) },
    { name: 'get_holdings', description: '보유 종목 전체를 JSON으로: 계좌, 종목, 수량, 평단, 현재가, 평가금액(원), 손익, 수익률, 비중, 등락률, 52주 고가 대비, 이동평균, 3개월 수익률, 추세 상태. 종목별 비교·필터 질문에 사용.', input_schema: obj() },
    { name: 'get_realized', description: '기간별 실현손익 요약(계좌별, 잘한/아쉬운 종목).', input_schema: obj({ period: { type: 'string', enum: PERIODS } }, ['period']) },
    { name: 'get_realized_rows', description: '실현손익 거래 내역 원본(JSON). 날짜 범위와 계좌·종목으로 거를 수 있음. 요약으로 답하기 어려운 질문에 사용.', input_schema: obj({ from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, account: { type: 'string' }, stock: { type: 'string' } }) },
    { name: 'get_history', description: '날짜별 총자산·주식평가·예수금 기록(JSON). 자산 변화 질문에 사용.', input_schema: obj({ from: { type: 'string' }, to: { type: 'string' } }) },
    { name: 'get_signals', description: '추세추종 스캔 결과: 오늘 장중 돌파, 종가 돌파, 2 Stage 관찰, 내 감시 종목.', input_schema: obj() },
    { name: 'analyze_stock', description: '종목 하나의 추세추종 판정(Stage), 52주 고가, 이동평균 정배열, 베이스·피벗, 손절가·목표가.', input_schema: obj({ query: { type: 'string', description: '종목명 또는 코드' } }, ['query']) },
    { name: 'get_stock_info', description: '종목의 시가총액·PER·PBR 등 기본정보, 연간·분기 실적, 회사 개요, 최근 외국인·기관 매매, 증권사 리포트 목록. 보유·신호 종목만 자료가 있음.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
    { name: 'get_disclosures', description: '최근 수집한 보유·관심 종목 DART 공시 목록.', input_schema: obj({ query: { type: 'string', description: '종목명(선택)' } }) },
    { name: 'get_watchlist', description: '내 감시 목록.', input_schema: obj() },
    { name: 'get_criteria', description: '스캔 기준 값들.', input_schema: obj() },
    { name: 'get_flows', description: '직접 기록한 입출금 목록.', input_schema: obj() },
    // ---- 변경 (확인 후 실행)
    { name: 'add_watch', description: '[변경] 감시 목록에 종목 추가. price 를 주면 그 가격 돌파 시, 없으면 피벗 거래량 동반 돌파 시 장중 알림.', input_schema: obj({ query: { type: 'string' }, price: { type: 'number' } }, ['query']) },
    { name: 'remove_watch', description: '[변경] 감시 목록에서 종목 삭제.', input_schema: obj({ query: { type: 'string' } }, ['query']) },
    { name: 'set_criteria', description: '[변경] 스캔 기준 값 바꾸기.', input_schema: obj({ key: { type: 'string', enum: criteriaKeys }, value: { type: 'number' } }, ['key', 'value']) },
    { name: 'set_breakout_alerts', description: '[변경] 장중 돌파 알림 켜기/끄기. 끌 때 days(며칠) 또는 forever.', input_schema: obj({ on: { type: 'boolean' }, days: { type: 'integer' }, forever: { type: 'boolean' } }, ['on']) },
    { name: 'set_news_alerts', description: '[변경] 보유 종목 공시·리포트 알림 켜기/끄기.', input_schema: obj({ on: { type: 'boolean' } }, ['on']) },
    { name: 'record_flow', description: '[변경] 수익률 계산용 입금/출금 기록 또는 삭제. amount 는 원 단위 정수.', input_schema: obj({ kind: { type: 'string', enum: ['in', 'out', 'delete'] }, account: { type: 'string', description: '계좌 이름 (예: 한투1, 키움(미국))' }, amount: { type: 'integer' }, date: { type: 'string', description: 'YYYY-MM-DD, 없으면 오늘' } }, ['kind', 'account']) },
  ];
}
const WRITE = new Set(['add_watch', 'remove_watch', 'set_criteria', 'set_breakout_alerts', 'set_news_alerts', 'record_flow']);

const won = (v) => Math.round(v).toLocaleString('ko-KR');
function describe(name, a, criteriaLabel) {
  switch (name) {
    case 'add_watch': return `⭐ 감시 추가: ${a.query}${a.price ? ` (${won(a.price)}원 돌파 시 알림)` : ' (피벗 거래량 동반 돌파 시 알림)'}`;
    case 'remove_watch': return `감시 삭제: ${a.query}`;
    case 'set_criteria': return `⚙️ 기준 변경: ${criteriaLabel(a.key)} → ${a.value}`;
    case 'set_breakout_alerts': return a.on ? '🔔 돌파 알림 켜기' : `🔕 돌파 알림 끄기 (${a.forever ? '켤 때까지' : `${a.days || 1}일`})`;
    case 'set_news_alerts': return a.on ? '📢 공시·리포트 알림 켜기' : '공시·리포트 알림 끄기';
    case 'record_flow': return a.kind === 'delete' ? `입출금 기록 삭제: ${a.date || '오늘'} ${a.account}` : `💵 ${a.kind === 'in' ? '입금' : '출금'} 기록: ${a.account} ${won(a.amount || 0)}원 (${a.date || '오늘'})`;
  }
  return name;
}

// ctx: 봇이 넘겨주는 기능들 (bot.mjs 참고)
export function createAI(ctx) {
  const cfg = ctx.config || {};
  const apiKey = cfg.apiKey;
  const model = cfg.model || 'claude-haiku-5-5';
  let history = [], lastAt = 0, pending = null;

  async function callClaude(messages, system, tools) {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1200, system, tools, messages }),
      });
      if (res.ok) return res.json();
      const body = await res.text();
      if (res.status === 401) throw new Error('Claude API 키가 맞지 않아요 (config.json 의 claude.apiKey 확인)');
      if (res.status === 400 && /credit/i.test(body)) throw new Error('Claude API 크레딧이 부족해요 (console.anthropic.com → Billing)');
      if ([429, 500, 529].includes(res.status)) { await new Promise((r) => setTimeout(r, 3000 * (i + 1))); continue; }
      throw new Error(`Claude API 오류 ${res.status}: ${body.slice(0, 200)}`);
    }
    throw new Error('Claude API가 바빠서 응답이 없어요. 잠시 후 다시 보내 주세요.');
  }

  async function runRead(name, a) {
    switch (name) {
      case 'get_status': return stripTags(await ctx.cmdStatus(!!a.detail));
      case 'get_holdings': return JSON.stringify(await ctx.holdingsJSON());
      case 'get_realized': return stripTags(await ctx.cmdRealized(a.period || '이번달'));
      case 'get_realized_rows': return JSON.stringify(await ctx.realizedRows(a));
      case 'get_history': return JSON.stringify(await ctx.historyRows(a));
      case 'get_signals': return stripTags(await ctx.cmdSignals());
      case 'analyze_stock': return stripTags(await ctx.cmdAnalyze(a.query));
      case 'get_stock_info': return JSON.stringify(await ctx.stockInfo(a.query));
      case 'get_disclosures': return JSON.stringify(await ctx.disclosures(a.query));
      case 'get_watchlist': return stripTags(await ctx.cmdWatch([]));
      case 'get_criteria': return stripTags(await ctx.cmdCriteria([]));
      case 'get_flows': return stripTags(await ctx.cmdFlow('list', []));
    }
    return '알 수 없는 기능';
  }
  async function runWrite(name, a) {
    switch (name) {
      case 'add_watch': return ctx.cmdWatch(['추가', ...String(a.query).split(/\s+/), ...(a.price ? [String(Math.round(a.price))] : [])]);
      case 'remove_watch': return ctx.cmdWatch(['삭제', ...String(a.query).split(/\s+/)]);
      case 'set_criteria': return ctx.cmdCriteria([a.key, String(a.value)]);
      case 'set_breakout_alerts': return ctx.cmdAlerts(!!a.on, a.on ? '' : a.forever ? '계속' : `${a.days || 1}일`);
      case 'set_news_alerts': return ctx.cmdNews(!!a.on);
      case 'record_flow': return ctx.cmdFlow(a.kind, [...String(a.account).split(/\s+/), ...(a.amount ? [String(Math.abs(a.amount))] : []), ...(a.date ? [a.date] : [])]);
    }
    return '알 수 없는 기능';
  }

  // 확인 대기 중인 변경에 대한 답("네"/"아니")이면 처리하고 결과를 돌려줌, 아니면 null
  async function confirm(text) {
    if (!pending) return null;
    if (Date.now() - pending.at > 10 * 60000) { pending = null; return null; }
    const t = text.trim();
    if (YES.test(t)) {
      const p = pending; pending = null;
      const out = [];
      for (const w of p.actions) out.push(await runWrite(w.name, w.input));
      history = [...history, { role: 'user', content: t }, { role: 'assistant', content: stripTags(out.join('\n')) }].slice(-8);
      return { html: out.join('\n\n') };
    }
    if (NO.test(t)) { pending = null; return { html: '알겠어요, 실행하지 않았어요.' }; }
    pending = null; // 다른 말을 하면 대기 중이던 변경은 취소
    return null;
  }

  async function answer(text) {
    if (!apiKey) return null;
    if (Date.now() - lastAt > 30 * 60000) history = [];
    lastAt = Date.now();
    const system = [
      '너는 사용자의 개인 주식 노트 텔레그램 봇이야. 한국어로, 텔레그램에서 읽기 좋게 짧고 정확하게 답해.',
      `오늘은 ${ctx.today()} (한국시간).`,
      `사용자 계좌: ${ctx.accountNames().join(', ') || '(불러오는 중)'}`,
      '숫자는 반드시 도구로 확인한 값만 쓰고, 추측해서 만들지 마. 필요한 도구를 먼저 불러.',
      '설정을 바꿔 달라는 요청이면 [변경] 도구를 불러. 실제 실행은 사용자가 "네"라고 확인한 뒤에 봇이 해.',
      '매수·매도 주문, 이체, 증권사 설정 변경은 할 수 없어. 그런 요청엔 할 수 없다고 말하고 대신 할 수 있는 조회나 감시 등록을 제안해.',
      '투자 판단을 단정하지 말고, 데이터와 사용자의 추세추종 기준(Stage, 피벗, 손절)에 근거해서 설명해.',
      '마크다운(**, #, 표)은 쓰지 마. 일반 텍스트와 줄바꿈, 이모지 정도만 써.',
    ].join('\n');
    const tools = toolDefs(ctx.criteriaKeys());
    const messages = [...history, { role: 'user', content: text }];
    for (let step = 0; step < 6; step++) {
      const r = await callClaude(messages, system, tools);
      messages.push({ role: 'assistant', content: r.content });
      const uses = r.content.filter((c) => c.type === 'tool_use');
      const said = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (!uses.length) {
        history = [...history, { role: 'user', content: text }, { role: 'assistant', content: said || '(답 없음)' }].slice(-8);
        return { text: said || '답을 만들지 못했어요. 다르게 물어봐 주세요.' };
      }
      const writes = uses.filter((u) => WRITE.has(u.name));
      if (writes.length) {
        pending = { at: Date.now(), actions: writes.map((w) => ({ name: w.name, input: w.input })) };
        const lines = writes.map((w) => describe(w.name, w.input, ctx.criteriaLabel));
        history = [...history, { role: 'user', content: text }, { role: 'assistant', content: `(확인 요청) ${lines.join(' / ')}` }].slice(-8);
        return { text: `${said ? said + '\n\n' : ''}이렇게 할까요?\n${lines.join('\n')}\n\n"네" 또는 "아니"로 답해 주세요.` };
      }
      const results = [];
      for (const u of uses) {
        let out;
        try { out = cap(await runRead(u.name, u.input || {})); } catch (e) { out = `오류: ${e.message}`; }
        ctx.log?.(`  도구 ${u.name}(${JSON.stringify(u.input)}) → ${out.length}자`);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: out });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: '질문이 복잡해서 끝까지 답하지 못했어요. 조금 나눠서 물어봐 주세요.' };
  }

  return { enabled: !!apiKey, confirm, answer };
}
