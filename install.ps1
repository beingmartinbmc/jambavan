# Jambavan installer — Windows / PowerShell 5.1+.
# One command. Finds supported coding agents and registers Jambavan where the
# host config can be updated safely; otherwise prints exact manual steps.
#
#   irm https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

Write-Host "Jambavan install`n" -ForegroundColor White

# --- Node version check -------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js >= 20.19.0 and < 27 is required. Install it from https://nodejs.org and re-run."
  exit 1
}
$nodeVersion = [version](node -p "process.versions.node")
if ($nodeVersion -lt [version]'20.19.0' -or $nodeVersion -ge [version]'27.0.0') {
  Write-Error "Node.js >= 20.19.0 and < 27 is required (found $(node -v)). Install a supported version and re-run."
  exit 1
}
Write-Host "  [ok] Node $(node -v)" -ForegroundColor Green

# Pre-fetch the npx cache so the first real tool call an agent makes isn't
# the one paying for the download.
npx -y jambavan --help *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Package preflight failed: npx could not install or run jambavan."
  exit 1
}

# --- Opt-in tools prompt ------------------------------------------------------
$allowWrite = $false
$allowBash  = $false
if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  Write-Host "`nEnable opt-in tools?" -ForegroundColor White
  Write-Host "  write_file / patch_file / jambavan_sankshipta  (JAMBAVAN_ALLOW_WRITE=1)"
  Write-Host "  bash                                           (JAMBAVAN_ALLOW_BASH=1)"
  Write-Host "These are disabled by default for safety. You can change this later by"
  Write-Host "editing the 'env' block in your agent's MCP config.`n"
  $ansWrite = Read-Host "  Enable write tools? [y/N]"
  $allowWrite = $ansWrite -match '^[Yy]$'
  $ansBash  = Read-Host "  Enable bash tool?   [y/N]"
  $allowBash  = $ansBash  -match '^[Yy]$'
  Write-Host ""
} else {
  Write-Host "  [!] Non-interactive run: write_file, patch_file, bash, and jambavan_sankshipta are disabled by default." -ForegroundColor Yellow
  Write-Host "  [!] Re-run the installer in a terminal to enable them, or set JAMBAVAN_ALLOW_WRITE=1 / JAMBAVAN_ALLOW_BASH=1" -ForegroundColor Yellow
  Write-Host "  [!] in your agent's MCP server env config.`n" -ForegroundColor Yellow
}

$found = $false

# --- Claude Code -------------------------------------------------------------
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
  $found = $true
  $list = (claude mcp list 2>$null) -join "`n"
  if ($list -match '(?m)^jambavan') {
    Write-Host "  [.] Claude Code - already registered" -ForegroundColor DarkGray
  } else {
    try {
      $envFlags = @()
      if ($allowWrite) { $envFlags += '-e'; $envFlags += 'JAMBAVAN_ALLOW_WRITE=1' }
      if ($allowBash)  { $envFlags += '-e'; $envFlags += 'JAMBAVAN_ALLOW_BASH=1'  }
      & claude mcp add @envFlags jambavan -- npx -y jambavan | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "claude mcp add exited with $LASTEXITCODE" }
      Write-Host "  [ok] Claude Code - registered" -ForegroundColor Green
    } catch {
      Write-Host "  [!] Claude Code - found but registration failed; try: claude mcp add jambavan -- npx -y jambavan" -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "  [.] Claude Code - not found" -ForegroundColor DarkGray
}

# --- Codex CLI ----------------------------------------------------------------
$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  $found = $true
  $list = (codex mcp list 2>$null) -join "`n"
  if ($list -match 'jambavan') {
    Write-Host "  [.] Codex CLI - already registered" -ForegroundColor DarkGray
  } else {
    try {
      $envFlags = @()
      if ($allowWrite) { $envFlags += '-e'; $envFlags += 'JAMBAVAN_ALLOW_WRITE=1' }
      if ($allowBash)  { $envFlags += '-e'; $envFlags += 'JAMBAVAN_ALLOW_BASH=1'  }
      & codex mcp add @envFlags jambavan -- npx -y jambavan | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "codex mcp add exited with $LASTEXITCODE" }
      Write-Host "  [ok] Codex CLI - registered" -ForegroundColor Green
    } catch {
      Write-Host "  [!] Codex CLI - found but registration failed; try: codex mcp add jambavan -- npx -y jambavan" -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "  [.] Codex CLI - not found" -ForegroundColor DarkGray
}

# --- Cursor (global mcp.json) -------------------------------------------------
$cursorDir = Join-Path $env:USERPROFILE ".cursor"
if (Test-Path $cursorDir) {
  $found = $true
  $mcpFile = Join-Path $cursorDir "mcp.json"
  $updateCursorConfig = @'
const fs = require("fs"), path = require("path");
const file = process.argv[2];
const aw = process.argv[3] === "true";
const ab = process.argv[4] === "true";
let cfg = {};
if (fs.existsSync(file)) {
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    console.error(`Malformed JSON in ${file}: ${error.message}`);
    process.exit(2);
  }
}
if (!cfg || Array.isArray(cfg) || typeof cfg !== "object") {
  console.error(`Invalid MCP config in ${file}: expected a JSON object`);
  process.exit(2);
}
if (cfg.mcpServers !== undefined &&
    (!cfg.mcpServers || Array.isArray(cfg.mcpServers) || typeof cfg.mcpServers !== "object")) {
  console.error(`Invalid MCP config in ${file}: mcpServers must be an object`);
  process.exit(2);
}
cfg.mcpServers = cfg.mcpServers || {};
if (cfg.mcpServers.jambavan) {
  process.stdout.write("exists");
  process.exit(0);
}
const entry = { command: "npx", args: ["-y", "jambavan"] };
if (aw || ab) {
  entry.env = {};
  if (aw) entry.env.JAMBAVAN_ALLOW_WRITE = "1";
  if (ab) entry.env.JAMBAVAN_ALLOW_BASH = "1";
}
cfg.mcpServers.jambavan = entry;
fs.mkdirSync(path.dirname(file), { recursive: true });
if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
const temp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(temp, JSON.stringify(cfg, null, 2) + "\n");
fs.renameSync(temp, file);
process.stdout.write("added");
'@
  $result = $updateCursorConfig | & node - $mcpFile $allowWrite.ToString().ToLowerInvariant() $allowBash.ToString().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Cursor config was not changed. Fix $mcpFile and re-run."
    exit 1
  }
  if ($result -eq 'exists') {
    Write-Host "  [.] Cursor - already registered" -ForegroundColor DarkGray
  } else {
    Write-Host "  [ok] Cursor - registered in $mcpFile" -ForegroundColor Green
  }
} else {
  Write-Host "  [.] Cursor - not found" -ForegroundColor DarkGray
}

# --- Continue (documented config.yaml) ----------------------------------------
$continueDir = Join-Path $env:USERPROFILE ".continue"
if (Test-Path $continueDir) {
  $found = $true
  $target = Join-Path $continueDir "config.yaml"
  if (Test-Path $target) {
    Write-Host "  [!] Continue - $target already exists; add this entry manually:" -ForegroundColor Yellow
    Write-Host "mcpServers:"
    Write-Host "  - name: Jambavan"
    Write-Host "    command: npx"
    Write-Host "    args:"
    Write-Host "      - -y"
    Write-Host "      - jambavan"
    if ($allowWrite -or $allowBash) {
      Write-Host "    env:"
      if ($allowWrite) { Write-Host '      JAMBAVAN_ALLOW_WRITE: "1"' }
      if ($allowBash)  { Write-Host '      JAMBAVAN_ALLOW_BASH: "1"' }
    }
  } else {
    $lines = @(
      'name: Local config',
      'version: 1.0.0',
      'schema: v1',
      'mcpServers:',
      '  - name: Jambavan',
      '    command: npx',
      '    args:',
      '      - -y',
      '      - jambavan'
    )
    if ($allowWrite -or $allowBash) {
      $lines += '    env:'
      if ($allowWrite) { $lines += '      JAMBAVAN_ALLOW_WRITE: "1"' }
      if ($allowBash)  { $lines += '      JAMBAVAN_ALLOW_BASH: "1"' }
    }
    $temp = "$target.tmp-$PID"
    [IO.File]::WriteAllLines($temp, $lines, [Text.UTF8Encoding]::new($false))
    Move-Item -Force $temp $target
    Write-Host "  [ok] Continue - registered in $target" -ForegroundColor Green
  }
} else {
  Write-Host "  [.] Continue - not found" -ForegroundColor DarkGray
}

Write-Host ""
if (-not $found) {
  Write-Host "No supported agent found on this machine (looked for Claude Code, Codex CLI, Cursor, Continue)." -ForegroundColor Yellow
  Write-Host "Install one, then re-run this script."
} else {
  Write-Host "Activate: restart your agent(s), then call jambavan_awaken once."
  Write-Host "Uninstall:"
  Write-Host "  Claude Code: claude mcp remove jambavan"
  Write-Host "  Codex CLI:   codex mcp remove jambavan"
  Write-Host "  Cursor:      remove mcpServers.jambavan from $env:USERPROFILE\.cursor\mcp.json, then restart Cursor"
  Write-Host "  Continue:    remove the Jambavan entry from $env:USERPROFILE\.continue\config.yaml, then restart Continue"
}
