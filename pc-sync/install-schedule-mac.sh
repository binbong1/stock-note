#!/bin/bash
# 맥에서 평일 16:00마다 sync.mjs 를 자동 실행하도록 등록합니다.
# 그 시간에 맥이 잠자기 상태였다면, 깨어날 때 한 번 실행됩니다.
# 실행: bash install-schedule-mac.sh      (해제: bash install-schedule-mac.sh remove)

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.stocknote.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$1" = "remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "자동 실행을 해제했어요."
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "Node.js가 없어요. https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행하세요."; exit 1; fi
if [ ! -f "$DIR/config.json" ]; then echo "config.json이 없어요. 먼저 'node setup.mjs'를 실행하세요."; exit 1; fi

mkdir -p "$HOME/Library/LaunchAgents"
DAYS=""
for d in 1 2 3 4 5; do
  DAYS="$DAYS<dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>16</integer><key>Minute</key><integer>0</integer></dict>"
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/sync.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StandardOutPath</key><string>$DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$DIR/sync.log</string>
  <key>StartCalendarInterval</key><array>$DAYS</array>
</dict></plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✔ 평일 16:00 자동 실행을 등록했어요. 기록은 $DIR/sync.log 에 남아요."
