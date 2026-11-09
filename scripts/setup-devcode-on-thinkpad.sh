#!/usr/bin/env bash
# Set up the renamed DevCode factory for one EXISTING project.
# Does not reset, delete, overwrite, or clone the user's project.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ $# -lt 1 ]]; then
  echo "Choose an existing project folder, for example:"
  echo "  bash scripts/setup-devcode-on-thinkpad.sh \"/full/path/to/existing/project\""
  exit 2
fi
[[ -d "$1" ]] || { echo "Project folder not found: $1" >&2; exit 2; }
PROJECT="$(cd "$1" && pwd -P)"
[[ -e "$PROJECT/.git" ]] || { echo "This is not the root of an existing saved Git project: $PROJECT" >&2; exit 2; }
[[ -f "$ROOT/scripts/devcode-project-continuity.mjs" ]] || {
  echo "DevCode Continuity Engine is missing. Pull the current DevCode feature branch first." >&2
  exit 2
}

command -v git >/dev/null || { echo "Git is missing." >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js is missing." >&2; exit 2; }
command -v ollama >/dev/null || { echo "Local Ollama service is missing." >&2; exit 2; }

# Detect the chosen local model; never silently substitute a cloud model.
MODEL="${OPENAI_MODEL:-}"
if [[ -z "$MODEL" ]]; then
  MODEL="$(python3 - "$HOME/.devcode/settings.json" "$HOME/.qwen/settings.json" <<'PY'
import json,sys
from pathlib import Path
for name in sys.argv[1:]:
    p=Path(name)
    if not p.is_file(): continue
    config=json.loads(p.read_text())
    models=config.get('modelProviders',{}).get('openai',[])
    preferred=config.get('model',{}).get('name','')
    valid=[x for x in models if isinstance(x,dict) and x.get('id')==preferred
           and x.get('baseUrl','').rstrip('/') in
           ('http://localhost:11434/v1','http://127.0.0.1:11434/v1')]
    if valid:
        print(preferred)
        break
else:
    raise SystemExit('Could not detect the local model. Export OPENAI_MODEL with its exact name.')
PY
)"
fi
ollama show "$MODEL" >/dev/null || {
  echo "Your local model is not available: $MODEL" >&2
  echo "Your project has not been changed." >&2
  exit 2
}

export OPENAI_MODEL="$MODEL"
export OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export DEVCODE_PROJECT_DIR="$PROJECT"

echo "DevCode name: DevCode"
echo "Existing project: $PROJECT"
echo "Main local model: $MODEL"
echo "Nothing will be rebuilt or erased."

# Reuse the canonical DevCode launcher instead of creating a divergent wrapper.
bash "$ROOT/scripts/install-devcode-command.sh"

# Prove the actual local model can edit code before enabling unattended work.
node "$ROOT/scripts/devcode-local-proof.mjs" || {
  echo "DevCode failed its local model editing proof. Factory not enabled." >&2
  exit 2
}

# The new engine never starts a new project. It inspects this actual Git folder.
node "$ROOT/scripts/devcode-project-continuity.mjs" --check

# Install the generic worker only for the explicitly selected project.
bash "$ROOT/scripts/install-devcode-project-service.sh" "$PROJECT"

echo
echo "DevCode has been configured to CONTINUE this project."
echo "Permanent project memory: $PROJECT/.devcode-factory/"
echo "If the user service is enabled, it will restart after crashes."
echo "For continuity across logout and reboot, optionally run:"
echo "  sudo loginctl enable-linger \"$USER\""
echo "To see your saved next step:"
echo "  cat \"$PROJECT/.devcode-factory/next-task.md\""
