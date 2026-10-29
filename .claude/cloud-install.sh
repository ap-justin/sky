#!/bin/bash
# installs the branch's own dependencies at session start on a cloud vm.
# registered in `.claude/settings.json` as a SessionStart hook on `startup|resume`.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
# nothing to install until the workspace is scaffolded
[ -f package.json ] || exit 0

# the pnpm the setup script installed, pinned by `packageManager`
ver=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\).*/\1/p' package.json)
[ -n "$ver" ] || { echo "cloud-install: no pnpm pin in packageManager" >&2; exit 1; }
home="${PNPM_HOME:-$HOME/.local/share/pnpm}"
exe="$home/.tools/pnpm-exe/$ver/pnpm"

# link the binary, not the `pnpm` wrapper in PNPM_HOME: the wrapper resolves the
# binary beside its own path, so a link to it breaks. the directory holds
# nothing else — /usr/local/bin carries the image's node 20, which shadows 22
# (wrangler refuses 20) unless the setup script put the repo's node there.
# pnpm 12's installer lays down no .tools binary, so its wrapper's own
# directory goes on PATH whole.
if [ -x "$exe" ]; then
  bin="$HOME/.kru-bin"
  mkdir -p "$bin"
  ln -sf "$exe" "$bin/pnpm"
else
  bin="$home/bin"
  [ -x "$bin/pnpm" ] || { echo "cloud-install: no pnpm $ver under $home" >&2; exit 1; }
fi
export PATH="$bin:$PATH"
# later shells read this file. without it they find the image's pnpm, which
# self-switches to `packageManager` with lifecycle scripts off, and turbo, which
# spawns that placeholder directly, fails with `Exec format error`.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

pnpm install --frozen-lockfile
