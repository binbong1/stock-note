#!/bin/bash
# 맥에 로그인해 있는 동안 텔레그램 봇이 항상 켜져 있도록 등록합니다. (맥 재시작 후에도 자동 실행)
# 실행: bash install-bot-mac.sh        해제: bash install-bot-mac.sh remove
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.stocknote.bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$1" = "remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "봇 자동 실행을 해제했어요."
  exit 0
fi

NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "Node.js가 없어요. https://nodejs.org 에서 설치하세요."; exit 1; }
grep -q '"telegram"' "$DIR/config.json" 2>/dev/null || { echo "봇 설정이 없어요. 먼저 'node setup-bot.mjs'를 실행하세요."; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/bot.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/bot.log</string>
  <key>StandardErrorPath</key><string>$DIR/bot.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✔ 봇을 켰어요. 맥에 로그인해 있는 동안 계속 실행돼요. 기록: $DIR/bot.log"
echo "  (터미널에서 'node bot.mjs'를 따로 켜 둔 게 있다면 Ctrl+C로 꺼 주세요. 두 개가 동시에 돌면 안 돼요.)"
