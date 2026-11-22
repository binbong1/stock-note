# 내 주식 노트 — Claude 작업 안내

이 폴더는 개인 주식 분석 사이트(https://binbong1.github.io/stock-note/)와 그 자동화 코드예요.
사용자는 텔레그램으로 요청하는 경우가 많아요. 답은 텔레그램에서 읽기 좋게 짧게, 한국어로.

## 절대 규칙
- 매수·매도 주문, 이체, 증권사 설정 변경은 하지 않아요. 증권사 API는 조회(잔고·체결)만 써요.
- `local/config.json`, `pc-sync/config.json` 에는 증권사 키·비밀번호·토큰이 있어요. 열지도, 출력하지도, 다른 곳에 보내지도 않아요.
- `data/*.enc.json` 은 잔고 암호화 파일이에요. 직접 풀려고 하지 말고 아래 `ask.mjs` 로만 조회해요.
- 입출금은 사용자가 알려준 것만 기록해요 (잔고로 추정하지 않음).

## 텔레그램 요청 처리 (예전 주식봇 기능)
계좌·잔고·실현손익·신호 등은 이 명령으로 가져와서 결과를 텔레그램으로 답해요 (사용자 본인 대화라 금액을 보여줘도 돼요):
- `node pc-sync/ask.mjs 현황` 총자산·계좌별 / `node pc-sync/ask.mjs 계좌` 계좌별 보유 종목
- `node pc-sync/ask.mjs 실현 이번달` (오늘·이번주·지난달·올해·3개월·전체 등)
- `node pc-sync/ask.mjs 신호` 추세추종 스캔 / `node pc-sync/ask.mjs 삼성전자` 종목 추세 분석
- `node pc-sync/ask.mjs 신용` 신용잔고 최근 5일 / `감시` / `기준` / `입출금` / `도움`
- `node scripts/surge.mjs --print` 지금 25% 이상 급등 종목 (보내지 않고 출력만 → 정리해서 답)
- 바꾸는 명령(`감시 추가 …`, `감시 삭제 …`, `기준 RS 80`, `입금 한투1 100만 2026-11-12`, `출금 …`, `알림 끄기`, `공시알림 끄기`, `신용알림 끄기`, `급등알림 끄기`, `급등 20`)은
  무엇을 바꿀지 텔레그램으로 먼저 확인받고 "네"라고 하면 실행해요. 바뀐 내용은 PC가 5분 안에 사이트에 반영해요.
- 자동 알림(보유 종목 공시, 장중 돌파, 장 마감 요약, 신용잔고 그래프, 급등주 정리 10:30·15:00)은 `local/run.mjs` 가 이 봇으로 직접 보내요. Claude가 따로 보낼 필요 없어요.
- 답은 숫자를 지어내지 말고 명령 출력에 있는 값만 써요.

## 종목 분석 요청 ("OO 기업분석 해줘")
- 사용자 블로그(파이어족 빈봉) 틀을 따라요: 기업 개요(시총·주주·CB/EB·PER/PBR/배당·연혁) → 투자 아이디어(✔ 소제목, 뉴스·산업 근거) → 산업·사업 분석 → 기업 분석(부문별 매출, 수주잔고와 매출 시차, 손익계산서 GPM/OPM/ROE, 재무상태표, 필요하면 현금흐름·CapEx·순유동자산/시총) → 투자 리스크 → 밸류에이션.
- 재무는 **최근 5개년 + 최근 분기**, 숫자는 DART 공시·네이버 증권 등 공개 자료에서만. 추정치는 "추정"이라고 표시. 문체는 "~함/~임" 개조식. 투자 판단은 단정하지 않음.
- 결과는 `data/notes/{코드}-{YYYYMMDD}.json` 으로 저장하고 `data/notes/index.json` 의 items 에 `{id, title, name, code, date, summary, file}` 추가 → 사이트 "종목 분석" 메뉴(#/note/{id})에 그래프와 함께 보여요. **한 종목 = 한 항목**: 블로그 글도 링크만 걸지 않고 내용(글·표·그림)을 옮겨 한 편의 노트로 저장해요(`source:"blog"`, 여러 편이면 한 글로 합치고 원문은 `blogs:[{label,url,date}]`). 추가 블록: `{type:"sub",text}` 작은 제목 / `{type:"img",src}` / `{type:"caption",text}` / `{type:"link",title,url,site}`. 같은 종목을 새로 분석하면 새 항목을 만들지 말고 기존 항목에 `file` 을 넣고 date·summary 를 갱신해요.
- 노트 JSON: `{title, name, code, date, priceNote, summary, kpis:[{label,value,sub}], sections:[{title, blocks:[...]}], sources:[...]}`
  블록: 문자열(문단, **굵게**·[링크](url) 가능) / `{type:"h",text}` ✔소제목 / `{type:"list",items}` / `{type:"table",title,unit,head,rows}` / `{type:"callout",text}` /
  `{type:"chart",title,unit,labels,bars:[{name,data}],line:{name,unit,data},note}` (막대 + 오른쪽 축 선, 예: 매출·영업이익 + OPM%)
- 사이트는 공개 주소라 분석에 잔고·보유 수량 같은 개인 정보는 넣지 않아요. 텔레그램에는 핵심 요약 + `https://binbong1.github.io/stock-note/#/note/{id}` 링크로 답해요.

## 산업 분석 요청 ("로봇 산업분석 해줘")
- 사용자 블로그 산업분석 시리즈(조선·우주항공·800V 서버랙, `data/sectors/`) 틀을 따라요:
  한눈에 보기 → 투자 아이디어(✔ 소제목, 시장규모·정책·뉴스 근거) → 사이클(시클리컬이면 과거 사이클 표: 기간·흐름·배경, 지금 위치) →
  밸류체인 전체(업스트림·미드·다운스트림) → 단계별 핵심 부품·기술과 **병목 기술** → 단계별 관련 종목(국내 + 해외, 무엇을 하는지 한 줄) → 체크할 투자지표 → 리스크.
- 밸류체인은 `{type:"chain",title,stages:[{name,desc,stocks:[...],bottleneck}]}` 블록으로 맨 위 "한눈에 보기"에 넣고, 본문에서 단계별로 자세히 풀어요.
- 숫자·종목 관계(납품·지분 등)는 공개 자료(뉴스·리포트·공시)로 확인한 것만, 출처를 `sources` 에. 추정은 "추정" 표시, 문체 "~함/~임", 투자 판단 단정 안 함.
- 저장: `data/sectors/{영문id}.json` (노트 JSON과 같은 형식, 섹션에 `part` 를 넣으면 목차가 편 단위로 묶임) + `data/sectors/index.json` items 에 `{id,title,name,date,summary,file,source:"claude"}`.
  **한 섹터 = 한 항목** (같은 섹터를 다시 분석하면 기존 항목 갱신). 텔레그램에는 핵심 요약 + `https://binbong1.github.io/stock-note/#/sector/{id}` 링크.

## 구성
- `index.html` — 사이트 전체 (대시보드, 자산 추이, 실현손익, 매매 신호, 종목 상세)
- `scripts/collect.mjs` 잔고·시세 수집 / `scan.mjs` 추세추종 스캔 / `news.mjs` 공시·리포트 / `credit.mjs` 신용잔고 / `surge.mjs` 급등주
- `pc-sync/bot.mjs` 텔레그램 주식봇(명령형), `pc-sync/ai.mjs` 주식봇 자연어 처리
- `local/run.mjs` 윈도우 PC 상시 실행기 (시간표, localhost:8080, 5분마다 GitHub 반영)
- `config/strategy.json` 추세추종 기준 (2% 룰 자산 = 한투2 계좌), `config/alerts.json` 알림·감시 목록, `config/accounts.json` 계좌 이름
- 공개 데이터: `data/summary.json`(시세·지표), `data/signals.json`(스캔 결과), `data/stocks/{코드}.json`(종목 상세), `data/credit.json`(신용잔고)

## 작업 방식
- 코드를 고치면 `node --check` 로 확인하고, 커밋·푸시 전에 무엇을 바꿀지 텔레그램으로 먼저 알려요.
- 커밋은 `git -c user.name=stock-note-pc ...` 처럼 이름을 붙여서. `git reset --hard` 는 PC 데이터를 지울 수 있어 쓰지 않아요.
- 시세·실적 등 지금 상황은 추측하지 말고 웹·공개 데이터로 확인해요. 투자 판단은 단정하지 않아요.
