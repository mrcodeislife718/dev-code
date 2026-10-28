#!/usr/bin/env bash
# Opt in to zero-cost cloud backup for DevCode, preserving your local 30B primary.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONFIG_DIR="$HOME/.config/devcode"
KEYFILE="$CONFIG_DIR/openrouter.env"
mkdir -p "$CONFIG_DIR"
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "Enter your OpenRouter API key (input hidden). No charge or credit purchase is required."
  read -rs -p "OpenRouter key: " OPENROUTER_API_KEY
  echo
fi
case "$OPENROUTER_API_KEY" in
  ''|*[!A-Za-z0-9._-]*)
    echo 'Invalid OpenRouter API key characters. No file written.' >&2
    exit 1
    ;;
esac
# Before changing settings, verify the key can be used and inspect the shared
# quota. Never make a paid request or send user code in setup.
node "$ROOT/scripts/register-openrouter-free-models.mjs"
temp="$(mktemp "$CONFIG_DIR/.openrouter-env.XXXXXXXX")"
chmod 600 "$temp"
printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY" > "$temp"
unset OPENROUTER_API_KEY
if [[ -f "$KEYFILE" ]]; then cp -p "$KEYFILE" "$KEYFILE.backup-$(date +%Y%m%d%H%M%S)"; fi
mv -f "$temp" "$KEYFILE"
echo "Saved key in private file ($KEYFILE, mode 600)."
if systemctl --user --quiet is-enabled devcode-jobflow-continuity.service 2>/dev/null; then
  systemctl --user daemon-reload
  systemctl --user restart devcode-jobflow-continuity.service
  echo 'Restarted DevCode continuity factory with opt-in cloud backup.'
else
  echo 'Install/reinstall the DevCode JobFlow continuity systemd service to activate backup.'
fi
echo 'To check free-only models and shared remaining quota:'
echo "  set -a; source '$KEYFILE'; set +a"
echo "  export DEVCODE_CLOUD_FALLBACK=1 OPENAI_MODEL=YOUR_EXISTING_LOCAL_MODEL"
echo "  node '$ROOT/scripts/jobflow-completion-runner.mjs' --cloud-check"
echo 'To disable OpenRouter: remove the OPENROUTER_API_KEY line from the private environment file and restart the service.'
