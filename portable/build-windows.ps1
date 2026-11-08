param(
  [string]$OutputFolder = 'C:\ClaudeStuff\Shared\handoff\property-hub-portable'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$bundleName = 'Property-Hub-Portable-Windows-x64'
$bundle = Join-Path $OutputFolder $bundleName
$zip = Join-Path $OutputFolder ($bundleName + '.zip')
$node = (Get-Command node.exe -ErrorAction Stop).Source

Write-Host '[1/6] Building app UI and validating TypeScript'
Push-Location $repo
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'App build failed' }
} finally { Pop-Location }

Write-Host '[2/6] Staging portable files'
New-Item -ItemType Directory -Force -Path $OutputFolder | Out-Null
if (Test-Path $bundle) { Remove-Item -Path $bundle -Recurse -Force }
$app = Join-Path $bundle 'app'
$runtime = Join-Path $bundle 'runtime'
$portable = Join-Path $bundle 'portable'
New-Item -ItemType Directory -Force -Path $app, $runtime, $portable, (Join-Path $app 'data') | Out-Null
Copy-Item -Path (Join-Path $repo 'server') -Destination (Join-Path $app 'server') -Recurse -Force
Copy-Item -Path (Join-Path $repo 'dist') -Destination (Join-Path $app 'dist') -Recurse -Force
Copy-Item -Path (Join-Path $repo 'data\inspection_template_seed.json') -Destination (Join-Path $app 'data\inspection_template_seed.json') -Force
Copy-Item -Path (Join-Path $repo 'package.json') -Destination (Join-Path $app 'package.json') -Force
Copy-Item -Path (Join-Path $repo 'package-lock.json') -Destination (Join-Path $app 'package-lock.json') -Force
Copy-Item -Path (Join-Path $repo 'portable\launcher.mjs') -Destination (Join-Path $portable 'launcher.mjs') -Force
Copy-Item -Path (Join-Path $repo 'portable\data-manager.mjs') -Destination (Join-Path $portable 'data-manager.mjs') -Force
Copy-Item -Path $node -Destination (Join-Path $runtime 'node.exe') -Force
$license = Join-Path $repo 'portable\NODE-LICENSE.txt'
if (!(Test-Path $license)) { throw 'Node.js redistribution LICENSE is missing; cannot package the runtime.' }
Copy-Item $license -Destination (Join-Path $runtime 'NODE-LICENSE.txt') -Force

Write-Host '[3/6] Installing production dependencies into isolated bundle (on build HP only)'
Push-Location $app
try {
  npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }
} finally { Pop-Location }
$native = Join-Path $app 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
if (!(Test-Path $native)) { throw 'SQLite native Windows binding missing — bundle incomplete' }

Write-Host '[4/6] Writing no-admin launch and recovery shortcuts'
function CmdFile([string]$name, [string]$command, [string]$lastLine) {
  $lines = @('@echo off','setlocal','cd /d "%~dp0"', $command, $lastLine)
  [System.IO.File]::WriteAllLines((Join-Path $bundle $name), $lines, [System.Text.Encoding]::ASCII)
}
CmdFile 'START Property Hub.cmd' '"%~dp0runtime\node.exe" "%~dp0portable\launcher.mjs"' 'if errorlevel 1 pause'
CmdFile 'TRY Demo (fictional properties).cmd' '"%~dp0runtime\node.exe" "%~dp0portable\launcher.mjs" --demo' 'if errorlevel 1 pause'
CmdFile 'BACKUP Property Hub.cmd' '"%~dp0runtime\node.exe" "%~dp0portable\data-manager.mjs" backup' 'pause'
CmdFile 'RESTORE Property Hub.cmd' '"%~dp0runtime\node.exe" "%~dp0portable\data-manager.mjs" restore' 'pause'
$guide = @'
PROPERTY HUB PORTABLE — WINDOWS x64
====================================
This distribution requires NO administrator rights and NO Node.js installation.

FIRST USE
1. Extract the entire ZIP to a normal local folder, e.g. Documents\Property Hub.
2. Double-click "TRY Demo (fictional properties).cmd" to explore 10 pretend sites.
3. Close that console window when finished.
4. Double-click "START Property Hub.cmd" to start the CLEAN real-work database.
5. Keep the black console window open while using the application.
   Your browser should open http://127.0.0.1:3001 automatically.
   If it does not, type that URL manually in Edge or Chrome.
6. Close the black console window to stop the app. Close the app BEFORE backup/restore.

DATA STORAGE — IMPORTANT
Normal data lives at:
  %LOCALAPPDATA%\PropertyHub\data
Demo data is completely separate:
  %LOCALAPPDATA%\PropertyHub\demo-data
The ZIP folder contains NO live database and NO real certificates.
Replacing an extracted release should not overwrite the saved data.

BACKUP & RESTORE
Close Property Hub, then double-click "BACKUP Property Hub.cmd".
A timestamped verified backup (database + documents + email drafts) goes to:
  %USERPROFILE%\Documents\Property Hub Backups
Backups are NOT ENCRYPTED. Store them only where your organisation permits;
make a separate secure copy if required. Laptop failure means local data may
be lost without an independent backup.
To recover: close the app; double-click "RESTORE Property Hub.cmd";
paste the FULL backup folder path; verify the details; type RESTORE.
The previous database is automatically backed up before replacement.

UPDATE
Close Property Hub, extract a newer portable release to a NEW app folder,
and start it normally. User data stays in %LOCALAPPDATA%\PropertyHub\data.
Do NOT reset or delete that data folder unless you intend to lose records.

LIMITATIONS
- For Windows x64 with standard Microsoft Edge or another default browser.
- No network access is exposed: localhost / 127.0.0.1 only.
- Reminder emails are drafts/demo mode only. No real email sends.
- No user accounts, login, automatic scheduler or cloud sync.
- Corporate AppLocker / WDAC / endpoint protection may block a bundled
  unsigned node.exe or .cmd files despite no administrator rights being
  needed. Do not bypass company controls: ask your IT team to approve it.
- This is an evaluation build using only fictional data. Get employer approval
  and check endpoint security, backup location and access protections BEFORE
  importing real accommodation addresses, certificates or resident details.
- SQLite native addon is bundled for Windows x64 and the included Node version.
- No software installation or registry changes are performed.

PROBLEM?
If the launcher reports "Port 3001 already in use", close the old app first.
If a work policy blocks the app, an IT-approved deployment will be needed.
If the browser did not launch, open http://127.0.0.1:3001 manually.
'@
[System.IO.File]::WriteAllText((Join-Path $bundle 'READ ME FIRST.txt'), $guide, [System.Text.UTF8Encoding]::new($false))

Write-Host '[5/6] Checking packaged runtime and dependencies without installed npm'
Push-Location $app
try {
  & (Join-Path $runtime 'node.exe') -e "require('better-sqlite3')(':memory:').close(); console.log('NATIVE_SQLITE_OK')"
  if ($LASTEXITCODE -ne 0) { throw 'SQLite native runtime failed inside the package' }
  & (Join-Path $runtime 'node.exe') --import tsx -e "console.log('TSX_PORTABLE_OK')"
  if ($LASTEXITCODE -ne 0) { throw 'Portable TSX loader failed' }
} finally { Pop-Location }

Write-Host '[6/6] Creating delivery ZIP'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $bundle -DestinationPath $zip -CompressionLevel Optimal
Get-Item $zip | Select-Object FullName,Length,LastWriteTime
$sha = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($zip)
try { $hash = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
Write-Host ('SHA256: ' + $hash)
Write-Host 'BUNDLE_READY'
