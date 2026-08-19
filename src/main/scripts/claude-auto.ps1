<#
  Claude Code auto-switch wrapper - installed by Claude Usage Dashboard.

  Runs `claude` signed in as one dashboard account (CLAUDE_CONFIG_DIR =
  ~/.claude-accounts/account-N). When that account hits its usage limit, Claude Code
  writes a `rate_limit` error into the session transcript; this script notices it,
  stops the CLI, copies the transcript to the next signed-in account with capacity
  left (as reported by the dashboard in ~/.claude-accounts/accounts.json), and
  resumes the very same session there with `claude --resume <id>` plus a short
  "continue where you left off" prompt - so the work goes on without a re-login.

  Only official CLI flags are used. No credentials are read or copied: the
  transcript (your conversation) is the only thing that moves between accounts.
#>
# Invoked by the generated launcher as:
#   set "CLAUDE_AUTO_ARGS=%*" & powershell -NoProfile -ExecutionPolicy Bypass -File claude-auto.ps1 -Account N
# (the user's claude arguments travel in CLAUDE_AUTO_ARGS because `powershell -File` would try to bind
#  things like `-p` or `--model` as script parameters).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$Account
)

$ErrorActionPreference = 'Continue'
# Splits a Windows command line into arguments (double quotes group, backslash escapes a quote).
function ConvertFrom-CmdLine([string]$line) {
  $out = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrWhiteSpace($line)) { return @() }
  $cur = New-Object System.Text.StringBuilder
  $inQuote = $false
  $hasToken = $false
  $i = 0
  while ($i -lt $line.Length) {
    $c = $line[$i]
    if ($c -eq '\') {
      $n = 0
      while ($i -lt $line.Length -and $line[$i] -eq '\') { $n++; $i++ }
      if ($i -lt $line.Length -and $line[$i] -eq '"') {
        [void]$cur.Append('\', [int][math]::Floor($n / 2))
        if ($n % 2 -eq 1) { [void]$cur.Append('"'); $i++ }
      } else {
        [void]$cur.Append('\', $n)
      }
      $hasToken = $true
      continue
    }
    if ($c -eq '"') { $inQuote = -not $inQuote; $hasToken = $true; $i++; continue }
    if (-not $inQuote -and ($c -eq ' ' -or $c -eq "`t")) {
      if ($hasToken) { $out.Add($cur.ToString()); [void]$cur.Clear(); $hasToken = $false }
      $i++
      continue
    }
    [void]$cur.Append($c); $hasToken = $true; $i++
  }
  if ($hasToken) { $out.Add($cur.ToString()) }
  return $out.ToArray()
}
[string[]]$ClaudeArgs = @(ConvertFrom-CmdLine $env:CLAUDE_AUTO_ARGS)
if ($null -eq $ClaudeArgs) { $ClaudeArgs = @() }
$Root = Join-Path $env:USERPROFILE '.claude-accounts'
if ($env:CLAUDE_AUTO_ROOT) { $Root = $env:CLAUDE_AUTO_ROOT }  # test hook
$StateFile = Join-Path $Root 'accounts.json'
$LogFile = Join-Path $Root 'auto-switch.log'
$PollMs = 1500
# How long an account that hit its limit in this run is skipped when the dashboard has no fresher reading.
$RetryAfterMinutes = 60
$ContinuePrompt = 'The previous Claude account hit its usage limit, so this session was moved to another account and resumed automatically. Continue exactly where you left off - do not start over or repeat work that is already done. If you were waiting for my input, briefly tell me what you were about to ask.'
$script:Current = $Account

function Write-Log([string]$msg) {
  try { Add-Content -Path $LogFile -Value ("{0} [account {1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $script:Current, $msg) -Encoding UTF8 } catch { }
}
function Write-Banner([string]$msg, [string]$color = 'Yellow') {
  Write-Host ''
  Write-Host ("  [Claude Usage Dashboard] " + $msg) -ForegroundColor $color
  Write-Host ''
}
function Read-State {
  try { if (Test-Path -LiteralPath $StateFile) { return (Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json) } } catch { }
  return $null
}
function Get-AccountName($state, [int]$id) {
  if ($state -and $state.accounts) { foreach ($a in $state.accounts) { if ([int]$a.id -eq $id -and $a.name) { return [string]$a.name } } }
  return "Account $id"
}
function Get-ConfigDir([int]$id) { return (Join-Path $Root ("account-" + $id)) }
function Test-CliSignedIn([int]$id) {
  # Existence check only (never read): Claude Code keeps its OAuth token in this file on Windows.
  return (Test-Path -LiteralPath (Join-Path (Get-ConfigDir $id) '.credentials.json'))
}
function Get-ClaudeCommand($state) {
  if ($state -and $state.claudePath -and (Test-Path -LiteralPath $state.claudePath)) { return [string]$state.claudePath }
  $c = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  foreach ($p in @((Join-Path $env:USERPROFILE '.local\bin\claude.exe'), (Join-Path $env:APPDATA 'npm\claude.cmd'))) { if (Test-Path -LiteralPath $p) { return $p } }
  return $null
}
# Windows command-line quoting for one argument (CommandLineToArgvW rules).
function ConvertTo-CmdArg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $s = $a -replace '(\\*)"', '$1$1\"'
  $s = $s -replace '(\\+)$', '$1$1'
  return '"' + $s + '"'
}
function Start-Claude([string]$claude, [string[]]$claudeArgs) {
  $quoted = @($claudeArgs | ForEach-Object { ConvertTo-CmdArg $_ })
  if ($claude -match '\.(cmd|bat)$') {
    # npm shim: needs cmd.exe. Killing the tree later also takes the real node process down.
    $line = '/d /c "' + ((@((ConvertTo-CmdArg $claude)) + $quoted) -join ' ') + '"'
    return Start-Process -FilePath $env:ComSpec -ArgumentList $line -NoNewWindow -PassThru
  }
  if ($quoted.Count -eq 0) { return Start-Process -FilePath $claude -NoNewWindow -PassThru }
  return Start-Process -FilePath $claude -ArgumentList ($quoted -join ' ') -NoNewWindow -PassThru
}
function Stop-Tree([int]$processId) {
  try { & taskkill.exe /PID $processId /T /F 2>&1 | Out-Null } catch { }
}
function Reset-Console {
  # Leave the alternate screen / raw modes the TUI may have been in when it was stopped.
  $esc = [char]27
  Write-Host -NoNewline ("{0}[?1049l{0}[?25h{0}[?1000l{0}[?1002l{0}[?1003l{0}[?1006l{0}[?2004l{0}[0m" -f $esc)
}
function Get-ProjectDirName {
  return ((Get-Location).Path -replace '[^A-Za-z0-9]', '-')
}
function Find-Transcript([string]$cfg, [string]$sessionId) {
  $projects = Join-Path $cfg 'projects'
  $expected = Join-Path (Join-Path $projects (Get-ProjectDirName)) ($sessionId + '.jsonl')
  if (Test-Path -LiteralPath $expected) { return $expected }
  if (-not (Test-Path -LiteralPath $projects)) { return $null }
  $f = Get-ChildItem -LiteralPath $projects -Filter ($sessionId + '.jsonl') -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { return $f.FullName }
  return $null
}
# Reads bytes appended since $state.offset (file is open for writing by the CLI); returns complete lines only.
function Read-NewLines([string]$path, $state) {
  $fs = $null
  $text = $null
  try {
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    if ($fs.Length -le $state.offset) { return @() }
    [void]$fs.Seek($state.offset, [System.IO.SeekOrigin]::Begin)
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $text = $state.tail + $sr.ReadToEnd()
    $state.offset = $fs.Length
  } catch { return @() } finally { if ($fs) { $fs.Dispose() } }
  if ($null -eq $text) { return @() }
  $lines = $text -split "`n"
  $state.tail = $lines[$lines.Count - 1]
  if ($lines.Count -le 1) { return @() }
  return $lines[0..($lines.Count - 2)]
}
function Test-LimitLine([string]$line, [string]$sessionId) {
  return ($line -match '"isApiErrorMessage":\s*true' -and $line -match '"error":\s*"rate_limit"' -and $line -match ('"sessionId":\s*"' + [regex]::Escape($sessionId) + '"'))
}
# Text currently visible in the console window. Interactive Claude Code (2.1.235+) shows the limit as a
# dialog ("You've hit your weekly limit ... What do you want to do?") and - on the very first message of a
# session - writes nothing to the transcript, so the screen is the only place the limit can be seen.
function Get-ViewportText {
  try {
    $ui = $host.UI.RawUI
    $pos = $ui.WindowPosition
    $size = $ui.WindowSize
    $rect = New-Object System.Management.Automation.Host.Rectangle $pos.X, $pos.Y, ($pos.X + $size.Width - 1), ($pos.Y + $size.Height - 1)
    $cells = $ui.GetBufferContents($rect)
    $sb = New-Object System.Text.StringBuilder
    for ($r = 0; $r -lt $cells.GetLength(0); $r++) {
      for ($c = 0; $c -lt $cells.GetLength(1); $c++) { $cell = $cells[$r, $c]; [void]$sb.Append($cell.Character) }
      [void]$sb.Append("`n")
    }
    return $sb.ToString()
  } catch { return '' }
}
function Test-LimitOnScreen {
  $t = (Get-ViewportText) -replace '\s+', ' '
  # Both halves of the CLI's limit dialog must be visible (avoids matching a conversation *about* limits).
  return ($t -match "You.ve hit your \w+ limit" -and $t -match "What do you want to do")
}
# Prompt the user typed into the CLI after $sinceMs (from the config dir's history.jsonl); null if none.
function Get-TypedPromptSince([string]$cfg, [int64]$sinceMs) {
  $file = Join-Path $cfg 'history.jsonl'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $cwd = ((Get-Location).Path -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
  $found = $null
  try {
    $lines = Get-Content -LiteralPath $file -Tail 50 -Encoding UTF8 -ErrorAction Stop
    foreach ($l in $lines) {
      if (-not $l) { continue }
      try { $e = $l | ConvertFrom-Json } catch { continue }
      if (-not $e.display -or $e.display -like '/*') { continue }
      if ($e.timestamp -and [int64]$e.timestamp -lt $sinceMs) { continue }
      $proj = [string]$e.project
      if ($proj -and (($proj -replace '\\', '/').TrimEnd('/').ToLowerInvariant() -ne $cwd)) { continue }
      $found = [string]$e.display
    }
  } catch { }
  return $found
}
# Picks the account to move to: dashboard recommendation first, then lowest usage; skips accounts that are
# not signed in to Claude Code, that the dashboard reports as exhausted, or that hit the limit in this run.
function Select-NextAccount($state, [int]$current, $failed) {
  $now = Get-Date
  $ids = @()
  $info = @{}
  if ($state -and $state.accounts) {
    foreach ($a in $state.accounts) { $ids += [int]$a.id; $info[[int]$a.id] = $a }
  } else {
    Get-ChildItem -LiteralPath $Root -Directory -Filter 'account-*' -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -match '^account-(\d+)$') { $ids += [int]$Matches[1] }
    }
  }
  $stateAt = $null
  if ($state -and $state.updatedAt) { $stateAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$state.updatedAt).LocalDateTime }
  $cands = @()
  foreach ($id in ($ids | Sort-Object -Unique)) {
    if ($id -eq $current) { continue }
    $a = $info[$id]
    $signedIn = $false
    if ($a -and $a.PSObject.Properties['claudeCodeLoggedIn'] -and $null -ne $a.claudeCodeLoggedIn) { $signedIn = [bool]$a.claudeCodeLoggedIn } else { $signedIn = Test-CliSignedIn $id }
    if (-not $signedIn) { continue }
    $pct = $null
    if ($a -and $a.PSObject.Properties['effectivePercent'] -and $null -ne $a.effectivePercent) { $pct = [double]$a.effectivePercent }
    if ($null -ne $pct -and $pct -ge 100) { continue }
    if ($failed.ContainsKey($id)) {
      $failedAt = $failed[$id]
      $freshReading = ($stateAt -and $stateAt -gt $failedAt -and $null -ne $pct -and $pct -lt 95)
      if (-not $freshReading -and $now -lt $failedAt.AddMinutes($RetryAfterMinutes)) { continue }
    }
    $rank = 1000
    if ($null -ne $pct) { $rank = $pct }
    if ($state -and $state.recommendedId -and [int]$state.recommendedId -eq $id) { $rank = -1 }
    $cands += [pscustomobject]@{ id = $id; rank = $rank }
  }
  if ($cands.Count -eq 0) { return $null }
  return ($cands | Sort-Object rank, id | Select-Object -First 1).id
}
# Copies the session transcript (and its side folder) into the target account's config dir so `--resume` finds it.
function Copy-Transcript([string]$transcript, [int]$targetId) {
  $srcDir = Split-Path -Parent $transcript
  $projectName = Split-Path -Leaf $srcDir
  $destDir = Join-Path (Join-Path (Get-ConfigDir $targetId) 'projects') $projectName
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  Copy-Item -LiteralPath $transcript -Destination $destDir -Force
  $side = Join-Path $srcDir ([System.IO.Path]::GetFileNameWithoutExtension($transcript))
  if (Test-Path -LiteralPath $side) { Copy-Item -LiteralPath $side -Destination $destDir -Recurse -Force }
}
# Flags that take a value (so the value is not mistaken for the initial prompt when we rebuild the command line).
$ValueFlags = @('--model', '--effort', '--permission-mode', '--agent', '--system-prompt', '--append-system-prompt', '--append-system-prompt-file',
  '--tools', '--mcp-config', '--settings', '--setting-sources', '--name', '-n', '--plugin-dir', '--plugin-url', '--worktree', '-w', '--max-turns',
  '--output-format', '--input-format', '--json-schema', '--fallback-model', '--permission-prompt-tool', '--resume-session-at', '--rewind-files',
  '--session-id', '--resume', '-r', '--max-budget-usd', '--sdk-url', '--file', '--environment', '--remote-control-session-name-prefix', '--agents',
  '--ide')
$VariadicFlags = @('--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--betas')
function Get-FlagsOnly([string[]]$claudeArgs) {
  # Returns the args without the positional prompt (kept: every flag and its value/values).
  $out = @()
  $i = 0
  while ($i -lt $claudeArgs.Count) {
    $a = $claudeArgs[$i]
    if ($a -like '-*') {
      $out += $a
      if ($a -notmatch '=') {
        if ($VariadicFlags -contains $a) {
          while ($i + 1 -lt $claudeArgs.Count -and $claudeArgs[$i + 1] -notlike '-*') { $i++; $out += $claudeArgs[$i] }
        } elseif ($ValueFlags -contains $a -and $i + 1 -lt $claudeArgs.Count) {
          $i++; $out += $claudeArgs[$i]
        }
      }
    }
    $i++
  }
  return $out
}

# ------------------------------------------------------------------ main -----
$state = Read-State
$Claude = Get-ClaudeCommand $state
if (-not $Claude) {
  Write-Banner 'The claude CLI was not found. Install Claude Code first: https://claude.com/claude-code' 'Red'
  exit 1
}

$Passthrough = $false
$autoOff = ($state -and $state.PSObject.Properties['autoSwitch'] -and $state.autoSwitch -eq $false)
if ($env:CLAUDE_AUTO_SWITCH -eq '0') { $autoOff = $true }
$Subcommands = @('agents', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'mcp', 'plugin', 'plugins', 'project', 'setup-token', 'ultrareview', 'update', 'upgrade', 'config', 'migrate-installer')
$NoWrapFlags = @('-c', '--continue', '-r', '--resume', '--session-id', '-v', '--version', '-h', '--help', '--fork-session', '--teleport', '--cloud', '--bg', '--background', '--remote-control', '--from-pr', '--no-session-persistence')
if ($ClaudeArgs.Count -gt 0 -and $Subcommands -contains $ClaudeArgs[0]) { $Passthrough = $true }
foreach ($a in $ClaudeArgs) { if ($NoWrapFlags -contains $a) { $Passthrough = $true } }
$PrintMode = (($ClaudeArgs -contains '-p') -or ($ClaudeArgs -contains '--print'))

if ($Passthrough -or $autoOff) {
  $env:CLAUDE_CONFIG_DIR = Get-ConfigDir $Account
  if ($Claude -match '\.(cmd|bat)$') {
    $line = (@((ConvertTo-CmdArg $Claude)) + @($ClaudeArgs | ForEach-Object { ConvertTo-CmdArg $_ })) -join ' '
    & $env:ComSpec /d /c "$line"
  } else {
    & $Claude @ClaudeArgs
  }
  exit $LASTEXITCODE
}

$SessionId = [guid]::NewGuid().ToString()
$Failed = @{}
$RunArgs = @('--session-id', $SessionId) + $ClaudeArgs
$Switches = 0
Write-Log ("start session {0} in {1} (print={2}) args: {3}" -f $SessionId, (Get-Location).Path, $PrintMode, ($ClaudeArgs -join ' '))

while ($true) {
  $cfg = Get-ConfigDir $script:Current
  $env:CLAUDE_CONFIG_DIR = $cfg
  # After a switch the (copied) transcript already exists and already contains the old account's limit
  # error: only lines appended from now on count.
  $transcript = $null
  $readState = @{ offset = [int64]0; tail = '' }
  if ($Switches -gt 0) {
    $transcript = Find-Transcript $cfg $SessionId
    if ($transcript) { try { $readState.offset = (Get-Item -LiteralPath $transcript).Length } catch { } }
  }
  # Fresh screen: the limit is also detected from the visible text, so nothing stale may be in view.
  if (-not $PrintMode) { try { Clear-Host } catch { } }
  $startedMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $proc = Start-Claude $Claude $RunArgs
  if (-not $proc) { Write-Banner 'Could not start claude.' 'Red'; exit 1 }
  $null = $proc.Handle  # makes ExitCode available later
  $limitHit = $false
  $noCandidateLogged = $false
  $nextId = $null

  while ($true) {
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds $PollMs
    $hit = $false
    if (-not $transcript) { $transcript = Find-Transcript $cfg $SessionId }
    if ($transcript) {
      foreach ($line in (Read-NewLines $transcript $readState)) { if (Test-LimitLine $line $SessionId) { $hit = $true } }
    }
    if (-not $hit -and -not $PrintMode -and (Test-LimitOnScreen)) { $hit = $true }
    if (-not $hit) { continue }
    $Failed[[int]$script:Current] = Get-Date
    $state = Read-State
    $nextId = Select-NextAccount $state $script:Current $Failed
    if ($null -eq $nextId) {
      if (-not $noCandidateLogged) { Write-Log 'usage limit reached - no other signed-in account with capacity left; staying'; $noCandidateLogged = $true }
      continue
    }
    $limitHit = $true
    if (-not $PrintMode) { break }
    # Print mode: the CLI exits by itself right after the error; re-run the request on the next account.
  }

  if (-not $limitHit) {
    # Print mode: the limit line may only be flushed right before exit - check once more.
    if ($PrintMode) {
      if (-not $transcript) { $transcript = Find-Transcript $cfg $SessionId }
      if ($transcript) {
        foreach ($line in (Read-NewLines $transcript $readState)) { if (Test-LimitLine $line $SessionId) { $limitHit = $true } }
      }
      if ($limitHit) {
        $Failed[[int]$script:Current] = Get-Date
        $nextId = Select-NextAccount (Read-State) $script:Current $Failed
        if ($null -eq $nextId) { $limitHit = $false }
      }
    }
    if (-not $limitHit) { exit $proc.ExitCode }
  }

  # ---- switch ----
  $state = Read-State
  $fromName = Get-AccountName $state $script:Current
  $toName = Get-AccountName $state $nextId
  Write-Log ("usage limit reached on {0} -> switching to account {1} ({2})" -f $fromName, $nextId, $toName)
  if (-not $proc.HasExited) { Stop-Tree $proc.Id; try { [void]$proc.WaitForExit(8000) } catch { } }
  Reset-Console
  if (-not $transcript) { $transcript = Find-Transcript $cfg $SessionId }
  $haveTranscript = ($transcript -and (Test-Path -LiteralPath $transcript))
  if ($haveTranscript) {
    try { Copy-Transcript $transcript $nextId } catch { Write-Log ("transcript copy failed: " + $_.Exception.Message); $haveTranscript = $false }
  }
  $script:Current = [int]$nextId
  $Switches++
  if ($PrintMode) {
    # Fresh session, identical request (the failed one only contains the error).
    $SessionId = [guid]::NewGuid().ToString()
    $RunArgs = @('--session-id', $SessionId) + $ClaudeArgs
  } elseif ($haveTranscript) {
    Write-Banner ("'{0}' hit its usage limit - continuing this session as '{1}' (no login needed)..." -f $fromName, $toName) 'Yellow'
    $RunArgs = @('--resume', $SessionId) + (Get-FlagsOnly $ClaudeArgs) + @($ContinuePrompt)
  } else {
    # Limit hit on the very first message: nothing was saved yet, so start over on the new account with the
    # same command line - and, if the prompt was typed into the CLI, re-send it from history.jsonl.
    Write-Banner ("'{0}' hit its usage limit - starting this session as '{1}' instead (no login needed)..." -f $fromName, $toName) 'Yellow'
    $typed = Get-TypedPromptSince $cfg $startedMs
    $SessionId = [guid]::NewGuid().ToString()
    if ($typed) { $RunArgs = @('--session-id', $SessionId) + (Get-FlagsOnly $ClaudeArgs) + @($typed) }
    else { $RunArgs = @('--session-id', $SessionId) + $ClaudeArgs }
  }
}
