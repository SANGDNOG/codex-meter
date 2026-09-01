#!/bin/sh
# Codex Meter per-user installer (Linux x64 / macOS arm64).
set -eu
umask 077

fail() { printf '%s\n' "codex-meter installer: $*" >&2; exit 1; }
SERVER_URL=''
TOKEN=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) [ "$#" -ge 2 ] || fail 'missing --server value'; SERVER_URL=$2; shift 2 ;;
    --token) [ "$#" -ge 2 ] || fail 'missing --token value'; TOKEN=$2; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ -n "$SERVER_URL" ] && [ -n "$TOKEN" ] || fail 'usage: install.sh --server HTTPS_URL --token ONE_TIME_TOKEN'
case "$SERVER_URL" in https://*) ;; http://127.0.0.1:*|http://localhost:*) [ "${CODEX_METER_ALLOW_HTTP_TESTS:-0}" = 1 ] || fail 'server URL must use HTTPS' ;; *) fail 'server URL must use HTTPS' ;; esac
SERVER_URL=${SERVER_URL%/}

OS=${CODEX_METER_UNAME_S:-$(uname -s)}
ARCH=${CODEX_METER_UNAME_M:-$(uname -m)}
HOME_DIR=${CODEX_METER_HOME:-$HOME}
case "$OS/$ARCH" in
  Linux/x86_64|Linux/amd64)
    TARGET=linux-x64; STATE_DIR=${XDG_STATE_HOME:-"$HOME_DIR/.local/state"}/codex-meter
    BIN_DIR="$HOME_DIR/.local/bin"; BIN="$BIN_DIR/codex-meter-agent"
    SERVICE_DIR=${XDG_CONFIG_HOME:-"$HOME_DIR/.config"}/systemd/user; SERVICE="$SERVICE_DIR/codex-meter-agent.service"; MODE=systemd ;;
  Darwin/arm64|Darwin/aarch64)
    TARGET=macos-arm64; STATE_DIR="$HOME_DIR/Library/Application Support/Codex Meter"
    BIN_DIR=$STATE_DIR; BIN="$BIN_DIR/codex-meter-agent"
    SERVICE_DIR="$HOME_DIR/Library/LaunchAgents"; SERVICE="$SERVICE_DIR/com.codex-meter.agent.plist"; MODE=launchd ;;
  *) fail "unsupported platform: $OS/$ARCH (supported: Linux x64, macOS arm64)" ;;
esac
CONFIG="$STATE_DIR/agent.json"
systemd_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
xml_escape() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
MANIFEST_URL="$SERVER_URL/api/v1/agent/releases/manifest.json"
CURL=${CODEX_METER_CURL:-curl}
command -v "$CURL" >/dev/null 2>&1 || fail 'curl is required'
mkdir -p "$STATE_DIR" "$BIN_DIR" "$SERVICE_DIR"
chmod 700 "$STATE_DIR" "$BIN_DIR" 2>/dev/null || true
MANIFEST="$STATE_DIR/.manifest.$$"
CANDIDATE="$BIN.update.$$"
cleanup() { rm -f "$MANIFEST" "$CANDIDATE"; }
trap cleanup EXIT HUP INT TERM
"$CURL" -fsSL "$MANIFEST_URL" -o "$MANIFEST" || fail 'could not download release manifest'
# The release manifest is JSON: {"version":"...","artifacts":{"TARGET":{"url":"...","sha256":"..."}}}.
COMPACT=$(tr -d '\r\n' < "$MANIFEST")
ENTRY=$(printf '%s' "$COMPACT" | sed -n "s/.*\"$TARGET\"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p")
[ -n "$ENTRY" ] || fail "manifest has no artifact for $TARGET"
ARTIFACT_URL=$(printf '%s' "$ENTRY" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')
EXPECTED=$(printf '%s' "$ENTRY" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9A-Fa-f]*\)".*/\1/p' | tr 'A-F' 'a-f')
case "$EXPECTED" in ''|*[!0-9a-f]*) fail 'manifest contains an invalid checksum' ;; esac
[ "${#EXPECTED}" -eq 64 ] || fail 'manifest contains an invalid checksum'
[ -n "$ARTIFACT_URL" ] || fail 'manifest contains an invalid artifact URL'
case "$ARTIFACT_URL" in https://*|http://*) DOWNLOAD_URL=$ARTIFACT_URL ;; /*) DOWNLOAD_URL="$SERVER_URL$ARTIFACT_URL" ;; *) DOWNLOAD_URL="$SERVER_URL/api/v1/agent/releases/$ARTIFACT_URL" ;; esac
"$CURL" -fsSL "$DOWNLOAD_URL" -o "$CANDIDATE" || fail 'could not download agent artifact'
if [ "$MODE" = systemd ]; then
  command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
  ACTUAL=$(sha256sum "$CANDIDATE" | cut -d ' ' -f 1)
else
  command -v shasum >/dev/null 2>&1 || fail 'shasum is required'
  ACTUAL=$(shasum -a 256 "$CANDIDATE" | cut -d ' ' -f 1)
fi
[ "$ACTUAL" = "$EXPECTED" ] || fail 'artifact checksum mismatch; existing installation was not changed'
chmod 700 "$CANDIDATE"
# Capture Codex from the interactive install environment; services intentionally do not receive a broad PATH.
CODEX_EXECUTABLE=''
CODEX_CANDIDATE=$(command -v codex 2>/dev/null || true)
case "$CODEX_CANDIDATE" in /*) [ -x "$CODEX_CANDIDATE" ] && CODEX_EXECUTABLE=$CODEX_CANDIDATE ;; esac
CODEX_ARGS=''
[ -z "$CODEX_EXECUTABLE" ] || CODEX_ARGS=1
# Enroll with the verified candidate before replacing an existing working executable.
if [ "${CODEX_METER_ALLOW_HTTP_TESTS:-0}" = 1 ]; then
  if [ -n "$CODEX_ARGS" ]; then "$CANDIDATE" enroll --server "$SERVER_URL" --token "$TOKEN" --config "$CONFIG" --codex-executable "$CODEX_EXECUTABLE" --allow-http-for-tests;
  else "$CANDIDATE" enroll --server "$SERVER_URL" --token "$TOKEN" --config "$CONFIG" --allow-http-for-tests; fi || fail 'enrollment failed; existing executable was not changed'
else
  if [ -n "$CODEX_ARGS" ]; then "$CANDIDATE" enroll --server "$SERVER_URL" --token "$TOKEN" --config "$CONFIG" --codex-executable "$CODEX_EXECUTABLE";
  else "$CANDIDATE" enroll --server "$SERVER_URL" --token "$TOKEN" --config "$CONFIG"; fi || fail 'enrollment failed; existing executable was not changed'
fi
chmod 600 "$CONFIG"
mv -f "$CANDIDATE" "$BIN"
chmod 700 "$BIN"

if [ "$MODE" = systemd ]; then
  BIN_SERVICE=$(systemd_escape "$BIN"); CONFIG_SERVICE=$(systemd_escape "$CONFIG")
  cat > "$SERVICE" <<EOF
[Unit]
Description=Codex Meter Agent
After=network-online.target

[Service]
Type=simple
ExecStart="$BIN_SERVICE" run --config "$CONFIG_SERVICE"
Restart=on-failure
RestartSec=5
Environment="CODEX_METER_EXECUTABLE=$BIN_SERVICE"

[Install]
WantedBy=default.target
EOF
  chmod 600 "$SERVICE"
  SYSTEMCTL=${CODEX_METER_SYSTEMCTL:-systemctl}
  "$SYSTEMCTL" --user daemon-reload
  "$SYSTEMCTL" --user enable --now codex-meter-agent.service
else
  BIN_XML=$(xml_escape "$BIN"); CONFIG_XML=$(xml_escape "$CONFIG"); STATE_XML=$(xml_escape "$STATE_DIR")
  cat > "$SERVICE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.codex-meter.agent</string>
<key>ProgramArguments</key><array><string>$BIN_XML</string><string>run</string><string>--config</string><string>$CONFIG_XML</string></array>
<key>EnvironmentVariables</key><dict><key>CODEX_METER_EXECUTABLE</key><string>$BIN_XML</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$STATE_XML/agent.log</string><key>StandardErrorPath</key><string>$STATE_XML/agent-error.log</string>
</dict></plist>
EOF
  chmod 600 "$SERVICE"
  LAUNCHCTL=${CODEX_METER_LAUNCHCTL:-launchctl}
  UID_VALUE=${CODEX_METER_UID:-$(id -u)}
  "$LAUNCHCTL" bootout "gui/$UID_VALUE" "$SERVICE" >/dev/null 2>&1 || true
  "$LAUNCHCTL" bootstrap "gui/$UID_VALUE" "$SERVICE"
  "$LAUNCHCTL" kickstart -k "gui/$UID_VALUE/com.codex-meter.agent"
fi
printf 'Codex Meter Agent installed and started: %s\n' "$BIN"
