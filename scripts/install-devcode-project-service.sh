#!/usr/bin/env bash
# Keep DevCode continuing this EXISTING project after logout and reboot.
# Usage: bash scripts/install-devcode-project-service.sh /full/path/to/project
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT="$(cd "${1:-$PWD}" && pwd -P)"
[[ -e "$PROJECT/.git" ]] || { echo 'This folder must be an existing Git project.' >&2; exit 1; }
[[ -f "$ROOT/scripts/devcode-project-continuity.mjs" ]] || { echo 'DevCode continuity file missing.' >&2; exit 1; }
MODEL="${OPENAI_MODEL:-}"
if [[ -z "$MODEL" ]]; then
  MODEL="$(python3 - "$HOME/.qwen/settings.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
if not p.exists(): raise SystemExit('Missing DevCode settings. Set OPENAI_MODEL before installing.')
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
WorkingDirectory="$PROJECT"
Environment="DEVCODE_PROJECT_DIR=$PROJECT"
Environment="OPENAI_BASE_URL=http://127.0.0.1:11434/v1"
Environment="OPENAI_MODEL=$MODEL"
Environment="OPENAI_API_KEY=local-only"
Environment="PATH=$PATH"
ExecStart="$(command -v node)" "$ROOT/scripts/devcode-project-continuity.mjs"
Restart=always
RestartSec=15
KillMode=control-group
TimeoutStopSec=45

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"
echo "Project: $PROJECT"
echo "Service: $SERVICE"
echo "To follow its work: journalctl --user -u $SERVICE -f"
echo "Your project code is preserved. Its memory is in $PROJECT/.devcode-factory/"
echo "For restart after logout/reboot, also run: sudo loginctl enable-linger \"$USER\""
