<#
  Keystone Ledger - Windows commands (same jobs as the Makefile).

  First time:   .\tasks.ps1 setup
  Every day:    .\tasks.ps1 run      (then open http://127.0.0.1:8787)
  Other:        .\tasks.ps1 help

  Works in Windows PowerShell 5.1 and PowerShell 7+. Keep this file plain ASCII:
  Windows PowerShell 5.1 misreads non-ASCII characters in files without a BOM.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('help', 'setup', 'run', 'dev', 'build', 'check', 'verify-links')]
    [string]$Task = 'help'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'

function Say([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# Run an external program and stop with a plain message if it fails.
function Invoke-Tool {
    param([string]$Exe, [string[]]$Arguments, [string]$Dir = $Root)
    Push-Location $Dir
    try {
        & $Exe @Arguments
        if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Arguments -join ' ')' failed (exit code $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}

function Assert-Tool([string]$Exe, [string]$HowToInstall) {
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "Missing: $Exe" -ForegroundColor Red
        Write-Host "  How to install: $HowToInstall"
        Write-Host "  Then CLOSE this PowerShell window, open a new one, and run the command again."
        exit 1
    }
}

function Assert-Tools {
    Assert-Tool 'uv' 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    Assert-Tool 'node' 'winget install OpenJS.NodeJS.LTS   (or download the LTS installer from https://nodejs.org)'
    Assert-Tool 'npm' 'it comes with Node.js (see above)'
}

function Invoke-Uv([string[]]$Arguments) { Invoke-Tool 'uv' (@('--directory', $Backend) + $Arguments) }
function Invoke-Npm([string[]]$Arguments) { Invoke-Tool 'npm' $Arguments $Frontend }

function Set-SecUserAgent {
    $envFile = Join-Path $Root '.env'
    if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^KL_SEC_USER_AGENT=".+@.+"' -Quiet)) {
        Say '.env already has your SEC contact line.'
        return
    }
    Write-Host ""
    Write-Host "The SEC (where company reports come from) asks every app to say who is reading."
    Write-Host "This is stored only in the .env file on this computer."
    $name = ''
    while (-not $name) { $name = (Read-Host 'Your name (e.g. Jane Smith)').Trim() }
    $email = ''
    while ($email -notmatch '^[^@\s"]+@[^@\s"]+\.[^@\s"]+$') { $email = (Read-Host 'Your email').Trim() }
    $name = $name -replace '"', ''
    $line = "KL_SEC_USER_AGENT=`"$name $email`""
    if (Test-Path $envFile) {
        $kept = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*KL_SEC_USER_AGENT=' }
        Set-Content -Path $envFile -Value (@($kept) + $line) -Encoding ASCII
    } else {
        Set-Content -Path $envFile -Value $line -Encoding ASCII
    }
    Say 'Saved your SEC contact line to .env'
}

function Invoke-Build { Say 'Building the app screens...'; Invoke-Npm @('run', 'build') }

function Invoke-VerifyLinks {
    Say 'Checking that every Learn-page link opens (needs internet)...'
    Invoke-Uv @('run', '--frozen', 'python', '-m', 'keystone_ledger.tools.verify_links')
}

switch ($Task) {
    'help' {
        Write-Host @"
Keystone Ledger commands (run from this folder in PowerShell):

  .\tasks.ps1 setup         First time only: install everything, ask for your SEC contact,
                            build the screens and check the Learn links.
  .\tasks.ps1 run           Start the app. Open http://127.0.0.1:8787 in your browser.
                            Keep this window open while you use it; press Ctrl+C to stop.
  .\tasks.ps1 verify-links  Re-check the Learn page links.
  .\tasks.ps1 check         Run every automated test and safety check (for developers).
  .\tasks.ps1 dev           Developer mode with live reload.
"@
    }
    'setup' {
        Assert-Tools
        Say 'Installing the app''s Python parts (exact versions from uv.lock)...'
        Invoke-Uv @('sync', '--frozen')
        Say 'Installing the app''s screen parts (exact versions from package-lock.json)...'
        Invoke-Npm @('ci', '--no-fund', '--no-audit')
        Set-SecUserAgent
        Invoke-Build
        try { Invoke-VerifyLinks } catch { Write-Host "Link check skipped: $_" -ForegroundColor Yellow }
        Write-Host ""
        Write-Host "All set! Next: .\tasks.ps1 run" -ForegroundColor Green
    }
    'build' { Assert-Tools; Invoke-Build }
    'run' {
        Assert-Tools
        if (-not (Test-Path (Join-Path $Frontend 'node_modules'))) {
            Write-Host "Run .\tasks.ps1 setup first." -ForegroundColor Red
            exit 1
        }
        Invoke-Build
        Say 'Starting Keystone Ledger at http://127.0.0.1:8787  (Ctrl+C to stop)'
        Invoke-Uv @('run', '--frozen', 'python', '-m', 'keystone_ledger.serve')
    }
    'dev' {
        Assert-Tools
        $env:KL_DEV_ORIGINS = '["http://127.0.0.1:5173"]'
        $uvArgs = @('--directory', $Backend, 'run', '--frozen', 'python', '-m', 'keystone_ledger.serve')
        $api = Start-Process -FilePath 'uv' -ArgumentList $uvArgs -NoNewWindow -PassThru
        try {
            Say 'API on :8787, screens with live reload on http://127.0.0.1:5173'
            Invoke-Npm @('run', 'dev')
        } finally {
            if (-not $api.HasExited) { Stop-Process -Id $api.Id }
        }
    }
    'verify-links' { Assert-Tools; Invoke-VerifyLinks }
    'check' {
        Assert-Tools
        Say 'Formatting and lint checks...'
        Invoke-Uv @('run', '--frozen', 'ruff', 'format', '--check', '.')
        Invoke-Uv @('run', '--frozen', 'ruff', 'check', '.')
        Invoke-Npm @('run', '-s', 'lint')
        Say 'Type checks...'
        Invoke-Uv @('run', '--frozen', 'mypy', 'src', 'tests')
        Invoke-Npm @('run', '-s', 'typecheck')
        Say 'Tests...'
        Invoke-Uv @('run', '--frozen', 'pytest')
        Invoke-Npm @('run', '-s', 'test')
        Say 'Security audit of every dependency...'
        $req = [System.IO.Path]::GetTempFileName()
        try {
            Invoke-Uv @('export', '--frozen', '--no-emit-project', '--format', 'requirements-txt', '-q', '-o', $req)
            Invoke-Uv @('run', '--frozen', 'pip-audit', '--progress-spinner', 'off', '--strict', '--require-hashes', '--disable-pip', '-r', $req)
        } finally {
            Remove-Item $req -ErrorAction SilentlyContinue
        }
        Invoke-Npm @('audit', '--audit-level=low')
        Write-Host "All checks passed." -ForegroundColor Green
    }
}
