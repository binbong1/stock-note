@echo off
chcp 65001 >nul
cd /d "%~dp0.."
curl -s http://127.0.0.1:8080/__stop >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\StockNote.vbs" 2>nul
node local\run.mjs mode github
echo.
echo 자동 실행을 지웠고, 다시 GitHub이 자동 실행하도록 바꿨어요.
pause
