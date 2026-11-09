#!/usr/bin/env bash
# Configure additional free cloud backups without replacing local Ollama.
# Each account is optional. Secrets go in a private file, never Git.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIR="$HOME/.config/devcode"
FILE="$DIR/openrouter.env"  # same file already loaded by the user service
mkdir -p "$DIR"
if [[ -f "$FILE" ]]; then
  chmod 600 "$FILE"
  # Only source your own existing private local configuration.
  set -a
  source "$FILE"
  set +a
  cp -p "$FILE" "$FILE.backup-$(date +%Y%m%d%H%M%S)"
fi

echo "Your 30B local model stays the main engine."
echo "For each cloud service, enter a key only if your account is on its FREE plan."
echo "If you skip a service, it remains unused."

prompt_key () {
  local prompt="$1" dest="$2" entered=''
  read -r -p "$prompt [y/N]: " reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then return; fi
  read -r -s -p "Paste the $dest key (hidden): " entered
  echo
  if [[ -z "$entered" || "$entered" == *$'\n'* || "$entered" == *' '* ]]; then
    echo "Invalid key: skipping $dest" >&2
    return
  fi
  printf -v "$dest" '%s' "$entered"
  export "$dest"
}

prompt_key "Enable OpenRouter FREE models?" OPENROUTER_API_KEY

read -r -p "Enable Groq FREE account backup? [y/N]: " reply
if [[ "$reply" =~ ^[Yy]$ ]]; then
  read -r -p "Confirm Groq account is on its FREE plan with no paid billing [type YES]: " confirmed
  if [[ "$confirmed" == YES ]]; then
    prompt_key "Add Groq now?" GROQ_API_KEY
    if [[ -n "${GROQ_API_KEY:-}" ]]; then export DEVCODE_GROQ_FREE_CONFIRMED=1; fi
  fi
fi

read -r -p "Enable Google AI Studio FREE project backup? [y/N]: " reply
if [[ "$reply" =~ ^[Yy]$ ]]; then
  read -r -p "Confirm the Gemini API key belongs to an UNBILLED FREE project [type YES]: " confirmed
  if [[ "$confirmed" == YES ]]; then
    prompt_key "Add Google AI Studio now?" GEMINI_API_KEY
    if [[ -n "${GEMINI_API_KEY:-}" ]]; then export DEVCODE_GEMINI_FREE_CONFIRMED=1; fi
  fi
fi

read -r -p "Enable Cloudflare Workers AI FREE plan backup? [y/N]: " reply
if [[ "$reply" =~ ^[Yy]$ ]]; then
  read -r -p "Confirm Cloudflare account is on Workers FREE plan, not Paid [type YES]: " confirmed
  if [[ "$confirmed" == YES ]]; then
    read -r -p "Cloudflare account ID (32 letters/numbers): " id
    if [[ "$id" =~ ^[0-9a-fA-F]{32}$ ]]; then
      export CLOUDFLARE_ACCOUNT_ID="$id"
      prompt_key "Add Cloudflare now?" CLOUDFLARE_API_TOKEN
      if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then export DEVCODE_CLOUDFLARE_FREE_CONFIRMED=1; fi
    else
      echo "Invalid Cloudflare account ID; keeping its backup disabled." >&2
    fi
  fi
fi

# Keep only approved environment fields, and never print the keys.
tmp="$(mktemp "$DIR/.free-cloud.XXXXXXXX")"
chmod 600 "$tmp"
{
  printf 'DEVCODE_CLOUD_FALLBACK=1\n'
  for name in OPENROUTER_API_KEY GROQ_API_KEY GEMINI_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
    value="${!name:-}"
    if [[ -n "$value" ]]; then
      if [[ "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then printf '%s=%s\n' "$name" "$value"; fi
    fi
  done
  for name in DEVCODE_GROQ_FREE_CONFIRMED DEVCODE_GEMINI_FREE_CONFIRMED DEVCODE_CLOUDFLARE_FREE_CONFIRMED; do
    if [[ "${!name:-}" == 1 ]]; then printf '%s=1\n' "$name"; fi
  done
} > "$tmp"
mv -f "$tmp" "$FILE"

node "$ROOT/scripts/register-free-cloud-models.mjs"

if systemctl --user --quiet is-active devcode-jobflow-continuity.service 2>/dev/null; then
  systemctl --user restart devcode-jobflow-continuity.service
  echo "Factory restarted with its new cloud backups."
else
  echo "No running factory service detected. Install or start it after configuration."
fi

echo "Setup complete. Local model remains first. No cloud payment was made."
echo "To see available backups without sending an AI request:"
echo "  set -a; source '$FILE'; set +a"
echo "  node '$ROOT/scripts/jobflow-completion-runner.mjs' --cloud-check"
