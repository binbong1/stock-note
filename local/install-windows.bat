@echo off
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0]>=22?0:1)"
if errorlevel 1 goto nonode
where git >nul 2>nul
if errorlevel 1 goto nogit
node local\install.mjs
pause
exit /b 0
:nonode
echo [!] Node.js 22+ is required.  Run in PowerShell:  winget install OpenJS.NodeJS.LTS
pause
exit /b 1
:nogit
echo [!] Git is required.  Run in PowerShell:  winget install Git.Git
pause
exit /b 1
