# Property Hub

A local-first, **single-operator property compliance tracker** (v0.3 model, P0 + P1). It covers:

- the Area › Site › Room › Equipment hierarchy;
- scheduled Compliance Activities;
- one central document library with reusable links;
- **manual** compliance recalculation;
- routine 30-point inspections with remedial actions;
- CSV exports and a printable site front sheet;
- reminder drafts you review before anything goes out.

Fictional demo data only.

## Run it (one command)

Requires Node 20+.

```bash
npm install && npm start
```

Then open **http://localhost:3001**. On first start the app creates `data/propertyhub.db` and seeds fictional demo data:

- 2 Areas, 10 Sites, rooms and equipment;
- 5 compliance types and 51 activities;
- 1 completed and 1 draft inspection.

An existing P0 database upgrades automatically: migration 2 is additive. The server listens on 127.0.0.1 only. It has no authentication, so don't expose it on a network.

| Command | Purpose |
|---|---|
| `npm start` | Build the UI and serve app + API on :3001 |
| `npm run dev` | Hot-reload dev mode (UI on :5173, API on :3001) |
| `npm test` | API, rule and CSV tests (Vitest, in-memory DB): 37 tests |
| `npm run e2e` | Build, start the app on a throwaway data folder, and drive the P0 + P1 browser journeys in headless Chrome |
| `npm run check` | Typecheck + tests + build + browser journeys (full gate) |
| `npm run typecheck` | TypeScript check |
| `npm run seed` | **Reset** the database to fresh demo data |

`PH_DATA_DIR` and `PORT` override the data folder and port. For `npm run e2e`, `CHROME_PATH` points it at a Chrome or Edge executable; installed Chrome, Edge or Chromium are found automatically. Screenshots, downloaded CSVs and `results.txt` are written to `e2e/output/`. A curated set is kept in [docs/screenshots](docs/screenshots), and the latest run is in [docs/e2e-results.txt](docs/e2e-results.txt).

## Portable Windows ZIP (no admin rights on target)

For a self-contained Windows x64 edition with bundled Node runtime, a **clean operational launcher**, a separate fictional Demo launcher and local Backup/Restore shortcuts, see [Portable Windows handover](docs/PORTABLE_WINDOWS.md).

Build from a Windows x64 developer machine with `powershell -NoProfile -File portable/build-windows.ps1`. On the **target laptop**, simply extract the ZIP and double-click `START Property Hub.cmd`: no Node/npm installation, no elevated rights and no network service. Corporate execution policies may still require IT approval.

Portable operational records live in `%LOCALAPPDATA%\PropertyHub\data` **outside** the extracted app folder; demo records use `%LOCALAPPDATA%\PropertyHub\demo-data`. Keep live data and backups out of Git. Do not import real sensitive accommodation data before work-device approval.

## What's built

### P0: core compliance
- **Dashboard** (home):
  - KPI tiles;
  - cascading Area › Site › Room filters, plus type, status, responsible person, equipment, due range and search;
  - views: All, Overdue, Due Soon, By Location, By Type, Missing Evidence.
- **Compliance Activities**: register with create and edit. Each activity has one type at Area, Site or Room level. Equipment is optional but must sit within that scope.
- **Equipment** register. **Documents**: upload once, link anywhere; Reviewed/Verified is a separate manual tick.
- **Site front sheet** (Location detail).
- **Admin / Setup**: People (contacts only, no logins), Core Data, Compliance Types, Settings.
- **Recalculate Compliance** is the only thing that changes statuses. Saves show *Changes pending recalculation*. Dates use Europe/London.
- **Reminders** come only from Recalculate. You preview them, then export `.eml` or demo-send to `data/outbox`. **Nothing is ever really emailed.**

### P1: inspections, actions, exports
- **Routine inspections** (`Inspections`, or **Start inspection** on a Site or Room page):
  - all 30 questions from `data/inspection_template_seed.json`, with exact wording and the 5 categories;
  - scope is a Site, or one Room in it; record the date and inspector;
  - each question takes Pass / Issue / Not applicable / Not checked, plus notes;
  - save a draft, resume later, see progress and outstanding questions (click to jump to one);
  - complete (every question must be answered), or reopen to correct;
  - full history per Site or Room;
  - supplementary documents come from the central library;
  - a banner states that a routine inspection is **not** a statutory certificate. Inspections never change compliance status or mark changes pending.
- **Remedial actions** (`Actions`):
  - an **Issue** answer offers *Create remedial action*;
  - fields: ref (`PH-X###`), title, description, priority (Low…Critical), owner/contact, due date, status, notes, room;
  - the source inspection and question are recorded;
  - optional link to a Compliance Activity at the same Site or Area. Activities elsewhere are rejected.
  - Lifecycle: Open → In progress → Done. Done requires closure details and a closed-on date. Reopening clears them.
  - The register filters by Area/Site/Room, priority, status, owner, overdue only and due-by date.
- **Critical rule**: an open Critical action linked to an Activity turns it red at the **next** manual Recalculate. Creating, closing or reopening an action only marks changes pending; the effect appears or disappears at the following Recalculate.
- **Exports**:
  - **Export CSV** on the Dashboard and Activities register exports exactly the rows the current filters show;
  - the Actions register exports its filtered list;
  - completed inspection results export as CSV, one row per question.
  - CSVs are UTF-8 with a BOM for Excel, and formula-injection safe.
- **Printable Site front sheet** (`Printable front sheet` on a Site): activities sorted by risk, open actions, recent inspections and documents. It shows when status was last calculated and warns if changes are pending.
- **UX**:
  - reference IDs no longer wrap; tables have zebra rows;
  - on phones the nav is a single scrollable row, forms and grids stack, and tap targets are larger;
  - inputs use 16px text so iOS doesn't zoom on focus.

### Not built yet
- **Service charges (P2)**: placeholder page only.
- **Document versions/revision history**: the `supersedes_document_id` column exists but has no UI.
- **Bulk/other exports**: there is no PDF export (use the browser's Print → Save as PDF on the front sheet) and no Equipment or Documents CSV.
- **Inspection templates**: they can't be edited in the UI. The 30-question template stays fixed as imported.

## Specs

1. [docs/OPUS_START_HERE.md](docs/OPUS_START_HERE.md): build mandate
2. [docs/PROPERTYHUB_UI_DATA_MODEL_V03.md](docs/PROPERTYHUB_UI_DATA_MODEL_V03.md): authoritative v0.3 model
3. [docs/PROPERTYHUB_BUILD_SPEC.md](docs/PROPERTYHUB_BUILD_SPEC.md): legacy v0.2 (date and reminder detail)

## Data and boundaries

The repository is source control, **not a document vault**. These are git-ignored:

- `data/propertyhub.db`
- `data/uploads/`
- `data/outbox/`
- `e2e/output/`

To back up, stop the app and copy `data/`. Do not enter real addresses, residents or certificates. Pushing, deployment and real email sending all require explicit instruction from the project owner.
