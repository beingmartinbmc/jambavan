# Jambavan installer — Windows / PowerShell 5.1+.
# One command. Finds every coding agent on your machine. Registers Jambavan
# as an MCP server for each one it finds. Safe to re-run.
#
#   irm https://raw.githubusercontent.com/beingmartinbmc/jambavan/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

Write-Host "Jambavan install`n" -ForegroundColor White

# --- Node version check -------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js >= 20 is required. Install it from https://nodejs.org and re-run."
  exit 1
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Error "Node.js >= 20 is required (found $(node -v)). Install a newer version and re-run."
  exit 1
}
Write-Host "  [ok] Node $(node -v)" -ForegroundColor Green

# Pre-fetch the npx cache so the first real tool call an agent makes isn't
# the one paying for the download.
npx -y jambavan --help *> $null

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
  $cfg = @{}
  if (Test-Path $mcpFile) {
    try { $cfg = Get-Content $mcpFile -Raw | ConvertFrom-Json -AsHashtable } catch { $cfg = @{} }
  }
  if (-not $cfg) { $cfg = @{} }
  if (-not $cfg.ContainsKey('mcpServers')) { $cfg['mcpServers'] = @{} }
  if ($cfg['mcpServers'].ContainsKey('jambavan')) {
    Write-Host "  [.] Cursor - already registered" -ForegroundColor DarkGray
  } else {
    $entry = @{ command = 'npx'; args = @('-y', 'jambavan') }
    if ($allowWrite -or $allowBash) {
      $envBlock = @{}
      if ($allowWrite) { $envBlock['JAMBAVAN_ALLOW_WRITE'] = '1' }
      if ($allowBash)  { $envBlock['JAMBAVAN_ALLOW_BASH']  = '1' }
      $entry['env'] = $envBlock
    }
    $cfg['mcpServers']['jambavan'] = $entry
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $mcpFile
    Write-Host "  [ok] Cursor - registered in $mcpFile" -ForegroundColor Green
  }
} else {
  Write-Host "  [.] Cursor - not found" -ForegroundColor DarkGray
}

# --- Continue (single-server JSON drop-in) ------------------------------------
$continueDir = Join-Path $env:USERPROFILE ".continue"
if (Test-Path $continueDir) {
  $found = $true
  $serversDir = Join-Path $continueDir "mcpServers"
  $target = Join-Path $serversDir "jambavan.json"
  if (Test-Path $target) {
    Write-Host "  [.] Continue - already registered" -ForegroundColor DarkGray
  } else {
    New-Item -ItemType Directory -Force -Path $serversDir | Out-Null
    $entry = @{ command = 'npx'; args = @('-y', 'jambavan') }
    if ($allowWrite -or $allowBash) {
      $envBlock = @{}
      if ($allowWrite) { $envBlock['JAMBAVAN_ALLOW_WRITE'] = '1' }
      if ($allowBash)  { $envBlock['JAMBAVAN_ALLOW_BASH']  = '1' }
      $entry['env'] = $envBlock
    }
    $entry | ConvertTo-Json -Depth 5 | Set-Content $target
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
  Write-Host "Done. Restart your agent(s) to pick up the new MCP server."
}
