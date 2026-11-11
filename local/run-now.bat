@echo off
chcp 65001 >nul
echo  1) 장 마감 작업 전체 (키움/토스 잔고 + 수집 + 스캔)
echo  2) 공시/리포트 확인
echo  3) 장중 돌파 감시
echo  4) GitHub 사이트에 바로 올리기
choice /C 1234 /M "무엇을 실행할까요"
if errorlevel 4 set J=publish& goto go
if errorlevel 3 set J=intraday& goto go
if errorlevel 2 set J=news& goto go
set J=evening
:go
curl -s "http://127.0.0.1:8080/__run?job=%J%"
echo.
echo 진행 상황: http://localhost:8080/__status   (기록: local\logs)
timeout /t 5 >nul
