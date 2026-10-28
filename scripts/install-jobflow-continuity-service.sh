#!/usr/bin/env bash
# Install the existing DevCode JobFlow continuity runner as a resilient user service.
# Does not alter Git branches, source files, Ollama models or production services.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEVROOT="$(cd "$HERE/.." && pwd -P)"
JOBFLOW_DIR="${1:-${JOBFLOW_DIR:-$PWD}}"
JOBFLOW_DIR="$(cd "$JOBFLOW_DIR" && pwd -P)"
BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:11434/v1}"
NODE="$(command -v node)"
SERVICE=devcode-jobflow-continuity.service

[[ -d "$JOBFLOW_DIR/.git" || -f "$JOBFLOW_DIR/.git" ]] || { echo "ERROR: Run from your existing JobFlow Git root, or pass the JobFlow directory." >&2; exit 2; }
[[ -f "$DEVROOT/scripts/jobflow-completion-runner.mjs" ]] || { echo "ERROR: DevCode runner not found." >&2; exit 2; }
BRANCH="$(git -C "$JOBFLOW_DIR" branch --show-current)"
if [[ "$BRANCH" != "jobflow-completion" && "${JOBFLOW_ALLOW_BRANCH:-}" != "$BRANCH" ]]; then
  echo "ERROR: Existing JobFlow branch is $BRANCH; runner expects jobflow-completion." >&2
  echo "Preserved your branch and files. Set JOBFLOW_ALLOW_BRANCH explicitly only if this is your intended working branch." >&2
  exit 2
fi
[[ "$BASE_URL" == "http://127.0.0.1:11434/v1" || "$BASE_URL" == "http://localhost:11434/v1" ]] || {
  echo "ERROR: This installer only accepts your local Ollama endpoint." >&2; exit 2;
}
command -v ollama >/dev/null || { echo "ERROR: Ollama missing." >&2; exit 2; }
command -v systemctl >/dev/null || { echo "ERROR: systemd missing." >&2; exit 2; }
MODEL="${OPENAI_MODEL:-}"
if [[ -z "$MODEL" ]]; then
  MODEL="$(python3 - "$HOME/.qwen/settings.json" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
if not p.is_file():
    raise SystemExit('DevCode model settings missing: '+str(p))
d=json.loads(p.read_text())
entries=d.get('modelProviders',{}).get('openai',[])
local=[m for m in entries if isinstance(m,dict) and m.get('baseUrl','').rstrip('/') in
       ('http://127.0.0.1:11434/v1','http://localhost:11434/v1')
       and m.get('wireApi','chat-completions')=='chat-completions']
selected=d.get('model',{}).get('name')
match=next((m for m in local if m.get('id')==selected),None)
if not match:
    if len(local)!=1: raise SystemExit('More than one local model configured; export OPENAI_MODEL before installing.')
    match=local[0]
print(match['id'])
PY
)"
fi
ollama show "$MODEL" >/dev/null || { echo "ERROR: Existing local model is not available: $MODEL" >&2; exit 2; }
echo "Checking actual local model function calling before enabling continuous work..."
(cd "$JOBFLOW_DIR" && JOBFLOW_DIR="$JOBFLOW_DIR" OPENAI_BASE_URL="$BASE_URL" OPENAI_MODEL="$MODEL" node "$DEVROOT/scripts/jobflow-completion-runner.mjs" --check) || {
  echo "ERROR: Local model tool calling is not verified. Service not started." >&2
  exit 2
}
case "$MODEL" in *$'\n'*|*'"'*|*' '* ) echo "ERROR: Unexpected model ID format." >&2; exit 2;; esac
# Percent specifiers and quotes are not safe unescaped in systemd unit paths.
case "$DEVROOT:$JOBFLOW_DIR:$NODE" in *%*|*'"'*|*$'\n'* ) echo "ERROR: Unsupported special characters in local paths." >&2; exit 2;; esac
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS"
TARGET="$UNITS/$SERVICE"
if [[ -f "$TARGET" ]]; then
  cp -p "$TARGET" "$TARGET.backup-$(date +%Y%m%d%H%M%S)"
fi
cat > "$TARGET" <<UNIT
[Unit]
Description=DevCode JobFlow Local Continuous Engineering Factory
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory="$JOBFLOW_DIR"
Environment="JOBFLOW_DIR=$JOBFLOW_DIR"
Environment="OPENAI_BASE_URL=$BASE_URL"
Environment="OPENAI_MODEL=$MODEL"
Environment="OPENAI_API_KEY=local-only"
Environment="DEVCODE_CLOUD_FALLBACK=1"
EnvironmentFile=-%h/.config/devcode/openrouter.env
Environment="JOBFLOW_ALLOW_BRANCH=${JOBFLOW_ALLOW_BRANCH:-}"
Environment="PATH=$PATH"
ExecStart="$NODE" "$DEVROOT/scripts/jobflow-completion-runner.mjs"
Restart=always
RestartSec=15
TimeoutStopSec=45
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
UNIT
echo "Installed configuration: $TARGET"
echo "DevCode checkout: $DEVROOT"
echo "JobFlow: $JOBFLOW_DIR"
echo "Local model: $MODEL"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"
systemctl --user --no-pager status "$SERVICE" || true
echo
echo "Status: systemctl --user status $SERVICE"
echo "Logs: journalctl --user -u $SERVICE -f"
echo "Stop manually: systemctl --user stop $SERVICE"
echo "To keep user services alive after logout: sudo loginctl enable-linger \"$USER\""
