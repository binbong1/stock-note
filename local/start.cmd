@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if not exist local\logs mkdir local\logs
:loop
node local\run.mjs daemon 1>nul 2>>local\logs\crash.log
if %errorlevel%==9 exit /b 0
timeout /t 15 /nobreak >nul
goto loop
