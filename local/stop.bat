@echo off
chcp 65001 >nul
cd /d "%~dp0.."
node local\run.mjs stop
timeout /t 3 >nul
