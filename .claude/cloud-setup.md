## Environment variables

```
KRU_STORE_REPO=ap-justin/kru-store
```

## Network access

Custom, with *include defaults* on, plus:

```
get.pnpm.io
ppa.launchpadcontent.net
mcp.context7.com
```

## Setup script

```bash
#!/bin/bash
# kru v0.159.0
set -uo pipefail
exec > >(tee -a /tmp/setup.log) 2>&1

try() {
  for _ in 1 2 3; do "$@" && return 0; sleep 2; done
  echo "SETUP FAIL: $*"
}

# kru store
try git clone -q https://github.com/ap-justin/kru-store ~/.kru
[ -f ~/.kru/setup.sh ] && try bash ~/.kru/setup.sh

# plugins
try claude plugin marketplace add anthropics/claude-plugins-official
try claude plugin marketplace add ap-justin/kru
try claude plugin install kru@kru --scope user
try claude plugin enable cc-plugin-you-should-know@builtin --scope user
try claude plugin install typescript-lsp@claude-plugins-official --scope user
try npm install -g typescript-language-server typescript@6

# harness: node 24 (engines; @fly/sprites requires it, the image ships 20-22) into /usr/local/bin
node24() {
  arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
  tar=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v24[0-9.]*-linux-$arch.tar.xz" | head -1)
  [ -n "$tar" ] || return 1
  mkdir -p /opt/node24 && curl -fsSL "https://nodejs.org/dist/latest-v24.x/$tar" | tar -xJ --strip-components=1 -C /opt/node24
  ln -sf /opt/node24/bin/node /opt/node24/bin/npm /opt/node24/bin/npx /usr/local/bin/
}
try node24

# harness: pnpm at package.json's packageManager; .claude/cloud-install.sh puts it on PATH
try env SHELL=/bin/bash PNPM_VERSION=10.19.0 sh -c 'curl -fsSL https://get.pnpm.io/install.sh | sh -'

node --version; "$HOME/.local/share/pnpm/.tools/pnpm-exe/10.19.0/pnpm" --version; claude plugin list
exit 0
```
