@echo off
chcp 65001 >nul
curl -s http://127.0.0.1:8080/__stop
echo.
echo 껐어요. 다시 켜려면 PC를 재시작하거나 local\start.cmd 를 더블클릭하세요.
timeout /t 3 >nul
