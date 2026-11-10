@echo off
chcp 65001 > nul
cd /d "%~dp0"
node sync.mjs >> sync.log 2>&1
