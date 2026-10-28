#!/usr/bin/env bash
# Install the visible "devcode" command without deleting an older installation.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
node "$ROOT/scripts/migrate-devcode-home.mjs"
NODE="$(command -v node)"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
COMMAND="$BIN/devcode"
if [[ -e "$COMMAND" || -L "$COMMAND" ]]; then
  cp -p "$COMMAND" "$COMMAND.backup-$(date +%Y%m%d%H%M%S)"
fi
# Escaped paths prevent spaces or unusual characters in project folders from
# changing how the startup script is run.
printf -v QNODE '%q' "$NODE"
printf -v QROOT '%q' "$ROOT/scripts/dev.js"
cat > "$COMMAND" <<SCRIPT
#!/usr/bin/env bash
export DEVCODE_HOME="\$HOME/.devcode"
exec $QNODE $QROOT "\$@"
SCRIPT
chmod 700 "$COMMAND"
PROFILE="$HOME/.profile"
LINE='export PATH="$HOME/.local/bin:$PATH"'
if [[ ! -f "$PROFILE" ]] || ! grep -Fqx "$LINE" "$PROFILE"; then
  printf '\n# DevCode command\n%s\n' "$LINE" >> "$PROFILE"
fi
echo "DevCode command installed: $COMMAND"
echo "Run it now as: $COMMAND --help"
echo "In a new terminal, type: devcode --help"
echo "Your original settings and project files were preserved."
