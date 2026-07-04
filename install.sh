#!/usr/bin/env bash
# Jambavan installer — macOS / Linux / WSL / Git Bash.
# One command. Finds every coding agent on your machine. Registers Jambavan
# as an MCP server for each one it finds. Safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.sh | bash
set -euo pipefail

GREEN='\033[32m'; YELLOW='\033[33m'; DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
skip() { printf "  ${DIM}·${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }

printf "${BOLD}Jambavan install${RESET}\n\n"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 20 is required. Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
node_major=$(node -p "process.versions.node.split('.')[0]")
if [ "$node_major" -lt 20 ]; then
  echo "Node.js >= 20 is required (found $(node -v)). Install a newer version and re-run." >&2
  exit 1
fi
ok "Node $(node -v)"

# Pre-fetch the npx cache so the first real tool call an agent makes isn't
# the one paying for the download.
npx -y jambavan --help >/dev/null 2>&1 || true

found=0

# --- Claude Code -------------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  found=1
  if claude mcp list 2>/dev/null | grep -q '^jambavan'; then
    skip "Claude Code — already registered"
  elif claude mcp add jambavan -- npx -y jambavan >/dev/null 2>&1; then
    ok "Claude Code — registered"
  else
    warn "Claude Code — found but registration failed; try: claude mcp add jambavan -- npx -y jambavan"
  fi
else
  skip "Claude Code — not found"
fi

# --- Codex CLI -----------------------------------------------------------------
if command -v codex >/dev/null 2>&1; then
  found=1
  if codex mcp list 2>/dev/null | grep -q 'jambavan'; then
    skip "Codex CLI — already registered"
  elif codex mcp add jambavan -- npx -y jambavan >/dev/null 2>&1; then
    ok "Codex CLI — registered"
  else
    warn "Codex CLI — found but registration failed; try: codex mcp add jambavan -- npx -y jambavan"
  fi
else
  skip "Codex CLI — not found"
fi

# --- Cursor (global ~/.cursor/mcp.json) ---------------------------------------
if [ -d "$HOME/.cursor" ]; then
  found=1
  result=$(node -e '
    const fs = require("fs"), path = require("path");
    const file = process.argv[1];
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    cfg.mcpServers = cfg.mcpServers || {};
    if (cfg.mcpServers.jambavan) { console.log("exists"); process.exit(0); }
    cfg.mcpServers.jambavan = { command: "npx", args: ["-y", "jambavan"] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    console.log("added");
  ' "$HOME/.cursor/mcp.json" 2>/dev/null) || result="error"
  case "$result" in
    added)  ok "Cursor — registered in ~/.cursor/mcp.json" ;;
    exists) skip "Cursor — already registered" ;;
    *)      warn "Cursor — found but could not update ~/.cursor/mcp.json" ;;
  esac
else
  skip "Cursor — not found"
fi

# --- Continue (single-server JSON drop-in) ------------------------------------
if [ -d "$HOME/.continue" ]; then
  found=1
  target="$HOME/.continue/mcpServers/jambavan.json"
  if [ -f "$target" ]; then
    skip "Continue — already registered"
  else
    mkdir -p "$HOME/.continue/mcpServers"
    cat > "$target" <<'EOF'
{ "command": "npx", "args": ["-y", "jambavan"] }
EOF
    ok "Continue — registered in ~/.continue/mcpServers/jambavan.json"
  fi
else
  skip "Continue — not found"
fi

echo
if [ "$found" -eq 0 ]; then
  warn "No supported agent found on this machine (looked for Claude Code, Codex CLI, Cursor, Continue)."
  echo "Install one, then re-run this script."
else
  echo "Done. Restart your agent(s) to pick up the new MCP server."
fi
