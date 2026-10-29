#!/usr/bin/env bash
# Keep DevCode continuing this EXISTING project after logout and reboot.
# Usage: bash scripts/install-devcode-project-service.sh /full/path/to/project
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT="$(cd "${1:-$PWD}" && pwd -P)"
[[ -e "$PROJECT/.git" ]] || { echo 'This folder must be an existing Git project.' >&2; exit 1; }
[[ -f "$ROOT/scripts/devcode-project-continuity.mjs" ]] || { echo 'DevCode continuity file missing.' >&2; exit 1; }
# Set up the DevCode settings name without touching your old saved records.
node "$ROOT/scripts/migrate-devcode-home.mjs"
MODEL="${OPENAI_MODEL:-}"
WALL_TIME="${DEVCODE_SESSION_WALL_TIME:-45m}"
WATCHDOG="${DEVCODE_ROUND_TIMEOUT_MS:-3600000}"
STALLED="${DEVCODE_MAX_STALLED_ROUNDS:-8}"
CODELESS="${DEVCODE_MAX_CODELESS_ROUNDS:-24}"
[[ "$WALL_TIME" =~ ^[0-9]+[smh]$ ]] || { echo 'Invalid session duration (example: 45m).' >&2; exit 1; }
[[ "$WATCHDOG" =~ ^[0-9]+$ && "$STALLED" =~ ^[0-9]+$ && "$CODELESS" =~ ^[0-9]+$ ]] || {
  echo 'Invalid timeout or no-progress setting.' >&2; exit 1;
}
if [[ -z "$MODEL" ]]; then
  MODEL="$(python3 - "$HOME/.devcode/settings.json" "$HOME/.qwen/settings.json" <<'PY'
import json,sys
from pathlib import Path
p=next((Path(v) for v in sys.argv[1:] if Path(v).exists()), None)
if p is None: raise SystemExit('Missing DevCode settings. Set OPENAI_MODEL before installing.')
settings=json.loads(p.read_text())
models=settings.get('modelProviders',{}).get('openai',[])
default=settings.get('model',{}).get('name','')
local=[m for m in models if m.get('id')==default and
  m.get('baseUrl','').rstrip('/') in ('http://localhost:11434/v1','http://127.0.0.1:11434/v1')]
if not local: raise SystemExit('Could not detect your selected local model. Set OPENAI_MODEL manually.')
print(default)
PY
)"
fi
# Neither the script nor the service adds a coding-request quota.
# Do not invoke the live runner here: the service starts it once after installation.
if systemctl --user --quiet is-active devcode-jobflow-continuity.service 2>/dev/null; then
  OLD_PROJECT="$(systemctl --user show -p WorkingDirectory --value devcode-jobflow-continuity.service 2>/dev/null || true)"
  if [[ -n "$OLD_PROJECT" && "$OLD_PROJECT" == "$PROJECT" ]]; then
    echo 'A previous DevCode factory is already running for this SAME project.' >&2
    echo 'Stop it before switching to the newer continuation engine:' >&2
    echo '  systemctl --user disable --now devcode-jobflow-continuity.service' >&2
    echo 'No project files or old service were changed.' >&2
    exit 2
  fi
fi
for val in "$MODEL" "$ROOT" "$PROJECT" "$(command -v node)"; do
  case "$val" in *%*|*$'\n'*|*'"'*) echo 'Unsupported special characters in model/path.' >&2; exit 1;; esac
done
IDENTITY="$(printf '%s' "$PROJECT" | sha256sum | cut -c1-12)"
SERVICE="devcode-project-$IDENTITY.service"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
if [[ -f "$UNIT_DIR/$SERVICE" ]]; then
  cp -p "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$SERVICE.backup-$(date +%Y%m%d%H%M%S)"
fi
cat > "$UNIT_DIR/$SERVICE" <<UNIT
[Unit]
Description=DevCode autonomous continuation for $IDENTITY
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$PROJECT
Environment="DEVCODE_PROJECT_DIR=$PROJECT"
Environment="DEVCODE_HOME=$HOME/.devcode"
Environment="OPENAI_BASE_URL=http://127.0.0.1:11434/v1"
Environment="OPENAI_MODEL=$MODEL"
Environment="OPENAI_API_KEY=local-only"
Environment="DEVCODE_SESSION_WALL_TIME=$WALL_TIME"
Environment="DEVCODE_ROUND_TIMEOUT_MS=$WATCHDOG"
Environment="DEVCODE_MAX_STALLED_ROUNDS=$STALLED"
Environment="DEVCODE_MAX_CODELESS_ROUNDS=$CODELESS"
Environment="PATH=$PATH"
# These commands belong to THIS project. Nothing will be deployed without
# an explicit release target and a live test configured by the owner.
EnvironmentFile=-%h/.config/devcode/production-$IDENTITY.env
ExecStart="$(command -v node)" "$ROOT/scripts/devcode-project-continuity.mjs"
Restart=on-failure
RestartSec=15
KillMode=control-group
TimeoutStopSec=45

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
# Fail fast on an invalid unit rather than printing a false success message.
systemd-analyze --user verify "$UNIT_DIR/$SERVICE" || {
  echo "DevCode service has an invalid systemd setting; no coding session started." >&2
  exit 1
}
systemctl --user enable --now "$SERVICE"
echo "Project: $PROJECT"
echo "Service: $SERVICE"
echo "To follow its work: journalctl --user -u $SERVICE -f"
echo "Your project code is preserved. Its memory is in $PROJECT/.devcode-factory/"
echo "Each coding round may run for $WALL_TIME; a separate watchdog monitors it."
echo "After $STALLED unproductive rounds or $CODELESS rounds without source edits, DevCode pauses for review."
echo "Optional production settings file:"
echo "  $HOME/.config/devcode/production-$IDENTITY.env"
echo "Deployment happens only when that file explicitly permits it, and tests pass."
echo "For restart after logout/reboot, also run: sudo loginctl enable-linger \"$USER\""
