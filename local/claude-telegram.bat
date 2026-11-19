@echo off
chcp 65001 >nul
cd /d "%~dp0.."
title Claude Telegram
echo Claude Code + Telegram channel. Keep this window open. (Ctrl+C to stop)
claude --channels plugin:telegram@claude-plugins-official %*
pause
