# Property Hub Portable — Windows x64 (no-admin distribution)

The Windows portable ZIP packages the **existing** React/Express/SQLite application with:
- a bundled Node.js x64 runtime (tested with Node 22.18.0);
- local Windows x64 `better-sqlite3` native binary and production dependencies;
- built frontend, Express server and the original 30-question template;
- START / TRY Demo / BACKUP / RESTORE command shortcuts.

**Nothing installs** on the target computer. No admin privileges, registry changes, Node/npm or PowerShell are required for normal use. IT security policies can nonetheless block the bundled unsigned `node.exe` or `.cmd` launchers; do not bypass them.

## Build (on an approved Windows x64 development machine)

From a PowerShell terminal with Node 22/npm installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\portable\build-windows.ps1
```

Default output: `C:\ClaudeStuff\Shared\handoff\property-hub-portable\Property-Hub-Portable-Windows-x64.zip`.
For a new release, build into a versioned folder so the previous ZIP stays untouched, e.g.
`-OutputFolder C:\ClaudeStuff\Shared\handoff\property-hub-portable\v0.5.0`.

This command performs a typechecked Vite build, installs only production Node dependencies **into a temporary bundle**, checks native SQLite loading through the *bundled* Node executable and produces the ZIP.

The target laptop only receives the ZIP. It does **not** run npm or any build process.

## Smoke-test the extracted ZIP

```powershell
$root = 'C:\path\to\extracted\Property-Hub-Portable-Windows-x64'
& "$root\runtime\node.exe" .\portable\smoke-windows.mjs $root
# optional: prove an older release's database upgrades cleanly (uses temporary data only)
& "$root\runtime\node.exe" .\portable\smoke-windows.mjs $root --upgrade-from 'C:\path\to\previous\Property-Hub-Portable-Windows-x64'
```

**Upgrading from v0.3.x to v0.5.0:** close the app, extract v0.5.0 to a *new* folder and start it. The database in `%LOCALAPPDATA%\PropertyHub` upgrades in place on first start (additive migration 3). Existing dates are preserved. An activity whose stored next-due date differs from last done + interval is kept as an **Override**, labelled "Next-due date entered before v0.5". Older routine 30-point inspections become visits flagged "Needs review" (same refs, answers and documents kept). Untick Override on the activity to switch it to the calculated date. Take a BACKUP first as usual.

The smoke test creates isolated temporary directories, starts the app using only its bundled runtime, checks a clean no-demo database, all five compliance types, browser static serving, persistence, backup/verify, restore, and separate fictional demo data. No production/user records are touched. The builder's delivery ZIP has been smoke-tested after extraction.

## Target workstation use

Extract to `Documents\Property Hub` or another user-writable local folder, not OneDrive, Program Files, or a network share. Then double-click:
- `TRY Demo (fictional properties).cmd` — seeded fictional data in `%LOCALAPPDATA%\PropertyHub\demo-data`
- `START Property Hub.cmd` — clean operational database in `%LOCALAPPDATA%\PropertyHub\data`
- `BACKUP Property Hub.cmd` — creates and SHA-256 verifies a dated copy of database **and documents** under the user's Documents\Property Hub Backups
- `RESTORE Property Hub.cmd` — checks backup manifest/hashes, requires typing RESTORE, makes a pre-restore backup and replaces all operational records/documents

The default browser opens `http://127.0.0.1:3001`. Keep the console window open. Close the application before any backup or restore. The port only listens on loopback, and no authentication is implemented.

**Data survives application updates** because the database and certificates live outside the extracted ZIP folder. Close the app, extract a new release to another folder and start it to reuse the existing `%LOCALAPPDATA%` data.

## Limits and go-live conditions

The portable build is **for evaluation with fictional data** until employer IT approval for an unsigned executable, local storage and backup location. Backups are not encrypted and the application has no login or account separation. No real emails are transmitted (demo draft/outbox only). Do not store addresses of refuges, residents' personal data or live compliance evidence on an unapproved work machine.

Never put `data/propertyhub.db`, uploaded files, email drafts, backups, private information or zip bundles into Git source control. This is a build script, not a public release workflow.

