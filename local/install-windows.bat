@echo off
chcp 65001 >nul
cd /d "%~dp0.."
title 내 주식 노트 - 윈도우 설치

echo.
echo ==== 내 주식 노트 : 윈도우 PC 설치 ====
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 없어요. 아래를 먼저 실행한 뒤 이 창을 닫고 다시 설치하세요:
  echo     winget install OpenJS.NodeJS.LTS
  pause & exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0]>=22?0:1)"
if errorlevel 1 (
  echo [!] Node.js 22 이상이 필요해요:  winget upgrade OpenJS.NodeJS.LTS
  pause & exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo [!] Git 이 없어요:  winget install Git.Git
  pause & exit /b 1
)
git config core.autocrlf false

echo [1/4] 키와 비밀번호 설정
node local\setup.mjs
if errorlevel 1 ( pause & exit /b 1 )

echo.
echo [2/4] 키움/토스 접속 확인 (이 PC의 인터넷 주소가 등록돼 있어야 해요)
for /f "delims=" %%i in ('curl -s https://api.ipify.org') do set MYIP=%%i
echo     이 PC의 공인 IP: %MYIP%
node local\run.mjs job sync
echo     위에 "IP" 또는 "토큰" 오류가 보이면 키움/토스 개발자 사이트에 위 IP를 등록한 뒤
echo     local\install-windows.bat 을 다시 실행하세요. (나머지 기능은 그대로 설치돼요)
echo.

echo [3/4] 켤 때마다 자동 실행 등록
if not exist local\logs mkdir local\logs
set "SU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\StockNote.vbs"
> "%SU%" echo CreateObject("WScript.Shell").Run """%~dp0start.cmd""", 0, False
echo     등록했어요: %SU%

choice /C YN /M "    PC가 절전모드로 들어가지 않게 할까요? (전원 연결 시, 권장)"
if not errorlevel 2 (
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  echo     절전 안 함으로 바꿨어요 ^(화면은 꺼져도 괜찮아요^)
)

echo.
echo [4/4] 지금 바로 시작
wscript "%SU%"
timeout /t 6 /nobreak >nul
start "" http://localhost:8080
echo.
echo ==== 완료 ====
echo  사이트(이 PC):  http://localhost:8080
echo  상태 보기:      http://localhost:8080/__status
echo  끄기:           local\stop.bat      /  완전 삭제: local\uninstall-windows.bat
echo  기록:           local\logs 폴더
echo.
pause
