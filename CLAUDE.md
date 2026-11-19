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
- 바꾸는 명령(`감시 추가 …`, `감시 삭제 …`, `기준 RS 80`, `입금 한투1 100만 2026-11-12`, `출금 …`, `알림 끄기`, `공시알림 끄기`, `신용알림 끄기`)은
  무엇을 바꿀지 텔레그램으로 먼저 확인받고 "네"라고 하면 실행해요. 바뀐 내용은 PC가 5분 안에 사이트에 반영해요.
- 자동 알림(보유 종목 공시, 장중 돌파, 장 마감 요약, 신용잔고 그래프)은 `local/run.mjs` 가 이 봇으로 직접 보내요. Claude가 따로 보낼 필요 없어요.
- 답은 숫자를 지어내지 말고 명령 출력에 있는 값만 써요.

## 구성
- `index.html` — 사이트 전체 (대시보드, 자산 추이, 실현손익, 매매 신호, 종목 상세)
- `scripts/collect.mjs` 잔고·시세 수집 / `scan.mjs` 추세추종 스캔 / `news.mjs` 공시·리포트 / `credit.mjs` 신용잔고
- `pc-sync/bot.mjs` 텔레그램 주식봇(명령형), `pc-sync/ai.mjs` 주식봇 자연어 처리
- `local/run.mjs` 윈도우 PC 상시 실행기 (시간표, localhost:8080, 5분마다 GitHub 반영)
- `config/strategy.json` 추세추종 기준 (2% 룰 자산 = 한투2 계좌), `config/alerts.json` 알림·감시 목록, `config/accounts.json` 계좌 이름
- 공개 데이터: `data/summary.json`(시세·지표), `data/signals.json`(스캔 결과), `data/stocks/{코드}.json`(종목 상세), `data/credit.json`(신용잔고)

## 작업 방식
- 코드를 고치면 `node --check` 로 확인하고, 커밋·푸시 전에 무엇을 바꿀지 텔레그램으로 먼저 알려요.
- 커밋은 `git -c user.name=stock-note-pc ...` 처럼 이름을 붙여서. `git reset --hard` 는 PC 데이터를 지울 수 있어 쓰지 않아요.
- 시세·실적 등 지금 상황은 추측하지 말고 웹·공개 데이터로 확인해요. 투자 판단은 단정하지 않아요.
