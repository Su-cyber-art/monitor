#!/bin/sh
# Installs the native macOS agent as a launchd daemon.
set -eu
[ "$(uname -s)" = Darwin ] || { echo "this installer requires macOS" >&2; exit 1; }
ROOT=/usr/local/monitor
AGENT_DIR=$ROOT/agent
BIN=$AGENT_DIR/monitor-agent
ENV_FILE=$ROOT/agent.env
PLIST=/Library/LaunchDaemons/dev.monitor.agent.plist
SERVICE=dev.monitor.agent
USER_NAME=_monitor-agent
SERVER=""
TOKEN=""
REGISTER=""
NAME=""
IFACE=""
IFACE_SET=""
INTERVAL=""
INSECURE=""
UNINSTALL=""
UPGRADE=""
BINARY=""

while [ $# -gt 0 ]; do
	case "$1" in
	--server | --token | --register | --name | --iface | --interval | --binary)
		[ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; } ;;
	esac
	case "$1" in
	--server) SERVER="$2"; shift 2 ;;
	--token) TOKEN="$2"; shift 2 ;;
	--register) REGISTER="$2"; shift 2 ;;
	--name) NAME="$2"; shift 2 ;;
	--iface) IFACE="$2"; IFACE_SET=1; shift 2 ;;
	--interval) INTERVAL="$2"; shift 2 ;;
	--binary) BINARY="$2"; shift 2 ;;
	--insecure) INSECURE=1; shift ;;
	--uninstall) UNINSTALL=1; shift ;;
	--upgrade) UPGRADE=1; shift ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }


if [ -n "$UNINSTALL" ]; then
	launchctl bootout system/$SERVICE 2>/dev/null || true
	rm -f "$PLIST" "$ENV_FILE" "$BIN" "$ROOT/monitor-agent.old" \
		"$AGENT_DIR/monitor-agent.previous" "$AGENT_DIR/monitor-agent.download" \
		"$AGENT_DIR/monitor-agent.backup" "$AGENT_DIR/monitor-agent.upgrade.json" \
		"$AGENT_DIR/monitor-agent.upgrade.tmp" "$ROOT/agent.log" "$ROOT/agent.env.old" "$ROOT/agent.plist.old"
	rmdir "$AGENT_DIR" "$ROOT" 2>/dev/null || true
	dscl . -delete /Users/$USER_NAME 2>/dev/null || true
	echo "monitor-agent uninstalled"
	exit 0
fi
if [ -n "$UPGRADE" ]; then
	[ -n "$INSECURE" ] || INSECURE=$(sed -n 's/^MONITOR_INSECURE=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	[ "$INSECURE" != 0 ] || INSECURE=""
	[ -z "$TOKEN$REGISTER" ] ||
		{ echo "--upgrade takes no --token or --register; it reuses what this machine holds" >&2; exit 2; }
	TOKEN=$(sed -n 's/^MONITOR_TOKEN=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	[ -n "$SERVER" ] || SERVER=$(sed -n 's/^MONITOR_SERVER=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	[ -n "$TOKEN" ] && [ -n "$SERVER" ] || {
		echo "no agent is installed here: $ENV_FILE holds no token and hub address." >&2
		echo "install it with the command from the panel instead" >&2
		exit 2
	}
fi

[ -n "$SERVER" ] && { [ -n "$TOKEN" ] || [ -n "$REGISTER" ]; } || {
	echo "usage: install-macos.sh --server URL (--token TOKEN | --register KEY) [--interval SECONDS] [--iface LIST] [--binary FILE] [--insecure]" >&2
	echo "       install-macos.sh --upgrade [--iface LIST] [--interval SECONDS] [--binary FILE]" >&2
	echo "       install-macos.sh --uninstall" >&2
	echo "--name NAME names the node --register creates, which is otherwise named after its id. < > \" ' are dropped from it; the panel renames a node freely" >&2
	echo "--binary FILE installs an agent already placed on this machine instead of downloading it from the hub" >&2
	exit 2
}
[ -z "$BINARY" ] || [ -f "$BINARY" ] || { echo "--binary: no file at $BINARY" >&2; exit 2; }
[ -z "$NAME" ] || [ -z "$TOKEN" ] ||
	{ echo "--name applies only with --register; rename an existing node in the panel" >&2; exit 2; }
if [ -z "$INTERVAL" ]; then
	INTERVAL=$(sed -n 's/^MONITOR_INTERVAL=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	INTERVAL=${INTERVAL:-1}
fi
case "$INTERVAL" in "" | *[!0-9]*) echo "interval must be an integer from 1 to 3600" >&2; exit 2 ;; esac
[ "$INTERVAL" -ge 1 ] && [ "$INTERVAL" -le 3600 ] || { echo "interval must be from 1 to 3600" >&2; exit 2; }
if [ -z "$IFACE_SET" ]; then
	IFACE=$(sed -n 's/^MONITOR_IFACE=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
	[ -z "$IFACE" ] || echo "keeping --iface $IFACE from the previous install"
else
	case ",$IFACE," in
	*[!A-Za-z0-9._,-]* | *,-,* | *,--*)
		echo "--iface takes full interface names separated by commas, each optionally led by -, not: $IFACE" >&2
		exit 2
		;;
	esac
fi
if [ -n "$INSECURE" ]; then SCHEME=http; else SCHEME=https; fi
lower_scheme() { printf '%s://%s' "$(printf '%s' "${1%%://*}" | tr 'A-Z' 'a-z')" "${1#*://}"; }
case "$SERVER" in
*://*) SERVER=$(lower_scheme "$SERVER") ;;
*) SERVER="$SCHEME://$SERVER" ;;
esac
HOST="${SERVER#*://}"
HOST="${HOST%%/*}"
case "$HOST" in
*@*) echo "server URL must not contain '@': the host is whatever follows it" >&2; exit 2 ;;
esac
case "$HOST" in
"["*) HOST="${HOST#\[}"; HOST="${HOST%%]*}" ;;
*) HOST="${HOST%%:*}" ;;
esac
case "$HOST" in
localhost | ::1) LOCAL=1 ;;
*[!0-9.]* | *.*.*.*.*) LOCAL="" ;;
127.[0-9]*.[0-9]*.[0-9]*) LOCAL=1 ;;
*) LOCAL="" ;;
esac
case "$SERVER" in
https://*) ;;
http://*)
	if [ -z "$LOCAL" ]; then
		[ -n "$INSECURE" ] || {
			echo "refusing plaintext http:// to a remote hub; use https://, or --insecure if it has no TLS" >&2
			exit 2
		}
		echo "warning: --insecure over plain HTTP to $SERVER" >&2
		echo "         the token and every report travel in the clear" >&2
		[ -n "$BINARY" ] || echo "         and the binary installed below is fetched over the same unverified channel" >&2
	fi
	;;
*)
	echo "server URL must start with https:// or http://, not: $SERVER" >&2
	exit 2
	;;
esac

case "$(uname -m)" in
x86_64) ARCH=x86_64; CPU=16777223 ;;
arm64|aarch64) ARCH=aarch64; CPU=16777228 ;;
*) echo "unsupported architecture" >&2; exit 1 ;;
esac
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=aarch64; CPU=16777228; fi
install -d -m 0755 "$ROOT"
TMP=$(mktemp "$ROOT/.agent.XXXXXX")
trap 'rm -f "$TMP"' EXIT
if [ -n "$BINARY" ]; then cp "$BINARY" "$TMP"
else curl -fSL --retry 3 --max-time 300 "${SERVER%/}/agent/$ARCH?os=macos" -o "$TMP"
fi
[ "$(od -An -tx1 -N4 "$TMP" | tr -d ' \n')" = cffaedfe ] &&
[ "$(od -An -tu4 -j4 -N4 "$TMP" | tr -d ' \n')" = "$CPU" ] ||
	{ echo "download is not a macOS executable for $ARCH" >&2; exit 1; }
chmod 0755 "$TMP"
VERSION=$("$TMP" --version)
case "$VERSION" in "monitor-agent "[0-9]*) ;; *) echo "agent version check failed" >&2; exit 1 ;; esac
if [ -z "$TOKEN" ]; then
	HELD=""
	CACHED=$(sed -n 's/^MONITOR_SERVER=//p' "$ENV_FILE" 2>/dev/null || true)
	if [ "$(lower_scheme "${CACHED%/}")" = "${SERVER%/}" ]; then
		HELD=$(sed -n 's/^MONITOR_TOKEN=//p' "$ENV_FILE" 2>/dev/null || true)
	fi
	echo "registering ${NAME:-this machine} with the hub"
	REPLY=$(printf '%s' "$NAME" | curl -sS --max-time 30 -w '\n%{http_code}' -H "Authorization: Bearer $REGISTER" \
		-H "X-Node-Token: $HELD" --data-binary @- "${SERVER%/}/api/agent/register") || exit 1
	CODE=$(printf '%s\n' "$REPLY" | tail -n 1)
	TOKEN=$(printf '%s\n' "$REPLY" | sed '$d')
	if [ "$CODE" != 200 ]; then
		printf 'registration failed (HTTP %s): %s\n' "$CODE" "$(printf '%s\n' "$TOKEN" | head -n 1 | cut -c1-500)" >&2
		[ -z "$HELD" ] || echo "if this machine's node was deleted or its token reissued, the token it holds no longer counts." >&2
		exit 1
	fi
	[ -n "$TOKEN" ] || { echo "the hub answered without a token" >&2; exit 1; }
	if [ "$TOKEN" = "$HELD" ]; then
		echo "this machine is already registered; keeping its token and the name the panel shows"
	elif [ -n "$HELD" ]; then
		echo "the token this machine held no longer opens a node; registered as a new node."
		echo "if that token was reissued rather than its node deleted, delete the old node in the panel."
	fi
fi


if ! id "$USER_NAME" >/dev/null 2>&1; then
	UID_VALUE=400
	while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$UID_VALUE"; do
		UID_VALUE=$((UID_VALUE + 1))
		[ "$UID_VALUE" -lt 500 ] || { echo "no free service user id" >&2; exit 1; }
	done
	dscl . -create /Users/$USER_NAME
	dscl . -create /Users/$USER_NAME UniqueID "$UID_VALUE"
	dscl . -create /Users/$USER_NAME PrimaryGroupID 1
	dscl . -create /Users/$USER_NAME UserShell /usr/bin/false
	dscl . -create /Users/$USER_NAME NFSHomeDirectory /var/empty
	dscl . -create /Users/$USER_NAME IsHidden 1
	dscl . -create /Users/$USER_NAME Password '*'
fi
launchctl bootout system/$SERVICE 2>/dev/null || true
install -d -m 0755 "$AGENT_DIR"
chown "$USER_NAME":daemon "$AGENT_DIR"
touch "$ROOT/agent.log"
chown "$USER_NAME":daemon "$ROOT/agent.log"
chmod 0600 "$ROOT/agent.log"
[ ! -f "$BIN" ] || cp "$BIN" "$ROOT/monitor-agent.old"
[ ! -f "$ENV_FILE" ] || cp -p "$ENV_FILE" "$ROOT/agent.env.old"
[ ! -f "$PLIST" ] || cp -p "$PLIST" "$ROOT/agent.plist.old"
chown "$USER_NAME":daemon "$TMP"
mv -f "$TMP" "$BIN"
rm -f "$AGENT_DIR/monitor-agent.upgrade.json" "$AGENT_DIR/monitor-agent.upgrade.tmp" \
	"$AGENT_DIR/monitor-agent.previous" "$AGENT_DIR/monitor-agent.backup" "$AGENT_DIR/monitor-agent.download"
xml() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
(
	umask 077
	cat >"$ENV_FILE" <<ENV
MONITOR_SERVER=$SERVER
MONITOR_TOKEN=$TOKEN
MONITOR_IFACE=$IFACE
MONITOR_INTERVAL=$INTERVAL
MONITOR_INSECURE=${INSECURE:-0}
ENV
	cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$SERVICE</string>
<key>ProgramArguments</key><array><string>$BIN</string></array>
<key>UserName</key><string>$USER_NAME</string>
<key>EnvironmentVariables</key><dict>
<key>MONITOR_SERVER</key><string>$(xml "$SERVER")</string>
<key>MONITOR_TOKEN</key><string>$(xml "$TOKEN")</string>
<key>MONITOR_IFACE</key><string>$(xml "$IFACE")</string>
<key>MONITOR_INTERVAL</key><string>$INTERVAL</string>
<key>MONITOR_INSECURE</key><string>${INSECURE:-0}</string>
<key>MONITOR_ALLOW_UPGRADE</key><string>1</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>$ROOT/agent.log</string>
<key>StandardErrorPath</key><string>$ROOT/agent.log</string>
</dict></plist>
PLIST
)
chmod 0600 "$ENV_FILE" "$PLIST"
chown root:wheel "$ENV_FILE" "$PLIST"
if launchctl bootstrap system "$PLIST"; then
	sleep 3
	if launchctl print system/$SERVICE | grep -q 'state = running'; then
		rm -f "$ROOT/monitor-agent.old" "$ROOT/agent.env.old" "$ROOT/agent.plist.old"
		echo "monitor-agent installed; log: $ROOT/agent.log"
		exit 0
	fi
fi
launchctl bootout system/$SERVICE 2>/dev/null || true
if [ -f "$ROOT/monitor-agent.old" ]; then
	mv -f "$ROOT/monitor-agent.old" "$BIN"
	chown "$USER_NAME":daemon "$BIN"
	[ ! -f "$ROOT/agent.env.old" ] || mv -f "$ROOT/agent.env.old" "$ENV_FILE"
	[ ! -f "$ROOT/agent.plist.old" ] || mv -f "$ROOT/agent.plist.old" "$PLIST"
	launchctl bootstrap system "$PLIST" || true
fi
echo "agent did not start; see $ROOT/agent.log" >&2
exit 1
