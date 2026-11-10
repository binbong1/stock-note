# 내 주식 노트

평일 장 마감 후(16:40)에 GitHub Actions가 시세, 추세 지표, DART 공시를 자동으로 모아서
`data/summary.json`에 저장합니다. 웹페이지(`index.html`)는 GitHub Pages로 무료 공개됩니다.

## 폴더 구성

| 파일 | 하는 일 |
|---|---|
| `config/watchlist.json` | 추적할 종목 목록과 신호 기준 (여기만 고치면 됨) |
| `scripts/collect.mjs` | 데이터 수집과 지표 계산 (외부 패키지 없음) |
| `.github/workflows/collect.yml` | 평일 16:40 자동 실행 설정 |
| `index.html` | 대시보드 화면 |
| `data/summary.json` | 수집 결과 (처음엔 샘플 데이터가 들어 있음) |

## 처음 설정하기 (한 번만, 약 15분)

### 1. DART API 키 받기 (공시용, 무료)
1. https://opendart.fss.or.kr 회원가입 → **인증키 신청/관리** → 인증키 신청
2. 발급된 40자리 키를 복사해 둡니다. (키가 없어도 시세·신호는 동작하고 공시만 빠집니다.)

### 2. GitHub 저장소 만들기
1. https://github.com 가입 → 오른쪽 위 **+** → **New repository**
2. 이름 예: `stock-note`, **Public** 선택 → Create repository
   - Public이어야 Actions와 Pages가 모두 무료입니다.

### 3. 파일 올리기
1. 저장소 화면에서 **uploading an existing file** 클릭
2. 압축을 푼 `stock-note` 폴더 **안의 내용물 전체**를 끌어다 놓고 **Commit changes**
3. `.github` 폴더는 숨김 폴더라 빠질 수 있어요. 목록에 `.github`가 안 보이면:
   **Add file → Create new file** → 파일 이름에 `.github/workflows/collect.yml` 입력 →
   `collect.yml` 내용을 붙여넣고 Commit

### 4. DART 키 등록
**Settings → Secrets and variables → Actions → New repository secret**
- Name: `DART_API_KEY`
- Secret: 1번에서 받은 키

### 5. 웹페이지 켜기
**Settings → Pages** → Source: **Deploy from a branch** → Branch: `main` / `/(root)` → Save
1~2분 뒤 `https://<내아이디>.github.io/stock-note/` 주소가 생깁니다.

### 6. 첫 수집 바로 실행
**Actions** 탭 → 왼쪽 **주식 데이터 수집** → **Run workflow**
초록 체크가 뜨면 끝. 웹페이지를 새로고침하면 샘플 배너가 사라지고 실제 데이터가 보입니다.

## 종목 추가·변경
`config/watchlist.json`의 `stocks`에 한 줄 추가하면 다음 실행부터 반영됩니다.

```json
{ "name": "종목명", "code": "6자리코드", "market": "KOSPI", "sector": "섹터명" }
```
- `market`: `KOSPI`, `KOSDAQ`, 미국 종목은 `NASDAQ` 또는 `NYSE` (code에 티커)
- 신호 기준(거래량 배수, ATR 배수 등)은 `settings`에서 바꿀 수 있습니다.

## 보유 수량·평단은 어디에 저장되나요?
웹페이지의 **보유 정보 입력** 화면에서 넣은 값과 매매 메모는 **내 브라우저에만** 저장됩니다.
GitHub(공개 저장소)에는 올라가지 않으니 금액이 노출되지 않아요.
대신 다른 기기에서는 한 번 다시 입력해야 합니다.
(종목 목록인 `watchlist.json`은 공개 저장소라 누구나 볼 수 있다는 점은 알아두세요.)

## 지표 계산 방식
- **52주 신고가 돌파**: 오늘 종가 > 오늘을 뺀 직전 250거래일 최고가
- **거래량 동반**: 오늘 거래량 ÷ 직전 20일 평균 ≥ `breakoutVolumeRatio`
- **정배열**: 20일선 > 60일선 > 120일선
- **손절가**: 최근 20일 최고 종가 − ATR(14) × `atrMultiplier`
- **상대강도**: 최근 63거래일(약 3개월) 수익률 − 지수(코스피/나스닥) 수익률

## 알아둘 점
- 시세는 네이버 금융(국내)과 야후 파이낸스(미국·지수·환율)의 **비공식** 경로에서 받아옵니다.
  사이트 구조가 바뀌면 수집이 실패할 수 있고, 실패하면 화면 위쪽에 빨간 안내가 뜹니다.
- 저장소에 60일 동안 아무 활동이 없으면 GitHub가 예약 실행을 멈출 수 있어요.
  안내 메일이 오면 Actions 탭에서 다시 켜면 됩니다.
- 투자 판단을 돕는 개인용 도구이며, 신호가 매수·매도 추천은 아닙니다.
