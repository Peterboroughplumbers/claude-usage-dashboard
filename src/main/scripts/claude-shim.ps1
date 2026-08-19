<#
  Installs (or removes) the `claude` PowerShell shim for Claude Usage Dashboard.

  The shim is a PowerShell function named `claude` that routes every `claude` you type
  through the dashboard's auto-switch wrapper (claude-auto.ps1). It starts on the account
  the dashboard recommends and, when that account hits its usage limit, moves the running
  session to another signed-in account and resumes it — no re-login, same terminal.

  It is written as a clearly-marked block into your PowerShell profile(s) so it can be
  updated or removed cleanly. Nothing else in the profile is touched.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File claude-shim.ps1 -Action install
    powershell -NoProfile -ExecutionPolicy Bypass -File claude-shim.ps1 -Action uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall')][string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'
$BeginMark = '# >>> Claude Usage Dashboard auto-switch shim >>>'
$EndMark = '# <<< Claude Usage Dashboard auto-switch shim <<<'

# The shim function body. Self-contained: depends only on the wrapper in %APPDATA% and,
# optionally, accounts.json (to pick the recommended starting account).
$Block = @"
$BeginMark
# Routes ``claude`` through the dashboard auto-switch wrapper (moves to another signed-in
# account on a usage limit). Delete this block to disable. Managed by Claude Usage Dashboard.
function claude {
  `$__helper = Join-Path `$env:APPDATA 'Claude Usage Dashboard\helpers\claude-auto.ps1'
  `$__real = (Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ((`$env:CLAUDE_AUTO_SWITCH -eq '0') -or -not (Test-Path -LiteralPath `$__helper)) {
    if (`$__real) { & `$__real.Source @args } else { Write-Error 'claude was not found.' }
    return
  }
  `$__acct = 1
  try {
    `$__st = Get-Content -LiteralPath (Join-Path `$env:USERPROFILE '.claude-accounts\accounts.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if (`$__st.recommendedId) { `$__acct = [int]`$__st.recommendedId }
    elseif (`$__st.accounts) { `$__acct = [int](`$__st.accounts | Sort-Object { if (`$null -ne `$_.effectivePercent) { [double]`$_.effectivePercent } else { 1000 } }, id | Select-Object -First 1).id }
  } catch { }
  `$__json = if (`$args.Count -gt 0) { ConvertTo-Json -InputObject ([string[]]`$args) -Compress } else { '[]' }
  # Run the wrapper in a child process so its `exit` can't close this terminal; same console (interactive works).
  `$env:CLAUDE_AUTO_ARGS_JSON = `$__json
  `$env:CLAUDE_AUTO_ARGS = ''
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File `$__helper -Account `$__acct
  } finally {
    Remove-Item Env:\CLAUDE_AUTO_ARGS_JSON -ErrorAction SilentlyContinue
  }
}
$EndMark
"@

function Get-ProfilePaths {
  $docs = [Environment]::GetFolderPath('MyDocuments')
  $paths = @(Join-Path $docs 'WindowsPowerShell\profile.ps1')
  # PowerShell 7+ uses a separate profile; include it when pwsh is installed.
  if (Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue) {
    $paths += Join-Path $docs 'PowerShell\profile.ps1'
  }
  return $paths
}

function Remove-Block([string]$text) {
  if (-not $text) { return '' }
  $pattern = [regex]::Escape($BeginMark) + '.*?' + [regex]::Escape($EndMark) + '\r?\n?'
  return [regex]::Replace($text, $pattern, '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
}

$done = @()
foreach ($profilePath in (Get-ProfilePaths)) {
  $dir = Split-Path -Parent $profilePath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $existing = ''
  if (Test-Path -LiteralPath $profilePath) { $existing = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 }
  $cleaned = Remove-Block $existing
  if ($Action -eq 'install') {
    $sep = if ($cleaned -and -not $cleaned.EndsWith("`n")) { "`r`n" } else { '' }
    $new = $cleaned + $sep + $Block + "`r`n"
  } else {
    $new = $cleaned
  }
  if ($new -ne $existing) {
    Set-Content -LiteralPath $profilePath -Value $new -Encoding UTF8 -NoNewline
  }
  $done += $profilePath
}

if ($Action -eq 'install') {
  Write-Host "Installed the 'claude' auto-switch shim into:"
} else {
  Write-Host "Removed the 'claude' auto-switch shim from:"
}
$done | ForEach-Object { Write-Host "  $_" }
Write-Host "Open a new terminal for it to take effect."
