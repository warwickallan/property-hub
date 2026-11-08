# Property Hub — Opus kickoff v0.3 (UPDATED UX + CORE DATA)

**Read this FIRST.** The product owner updated the core data structure and screen design on 2026-11-08. The previous flat-property/flat-check backend and references to "no room registers" are **obsolete**.

**Authoritative priority:** `docs/PROPERTYHUB_UI_DATA_MODEL_V03.md` (new hierarchy, UI and schema) overrides conflicting content in `docs/PROPERTYHUB_BUILD_SPEC.md` (v0.2: continue using its useful date logic, checklist, reminders and safeguards). `data/inspection_template_seed.json` contains the original 30 questions.

## Build mandate: Working software, not planning

Build one simple, usable, local-first **React + Vite + TypeScript UI**, **Express + TypeScript API**, **SQLite (better-sqlite3)**, private local file storage. There is **one interactive operator** in P0. Other staff can be added through Admin > People/Users as directory contacts and email recipients only. Do not add logins, invitations or RBAC workflows. No background jobs, no automatic recalculation, no real emails, no live data, no public deployments.

### Correct relational model

```text
Area 1 ---- N Site 1 ---- N Room 1 ---- N Equipment
                             /
Compliance Type 1 ---- N Compliance Activity ---- 1 (Area OR Site OR Room)
                                  |
                                  N ---- M Equipment (Activity Equipment links)
                                  |
                              Document links ---- N Central Document Library
```

**Activity** is the scheduled obligation at a specific location (not merely a compliance type automatically assigned to every Site). The five initial types: PAT, FRA, Gas Safety, Legionella, EICR; Admin can add others. Equipment MUST belong to a Room and may be linked to applicable Activities using a many-to-many link. **Site is the property**; do not duplicate a separate properties table. Location-scoped Activities may have zero equipment (e.g. FRA at a Site).

**Documents:** file bytes stored once in local private `data/uploads`, metadata in SQLite; `document_links` allows the same file to appear against Area/Site/Room/Equipment/Activity/Inspection/Action. Direct file-picker links, no duplicate uploads. Verification explicit, independent from upload. Every screen that has linked files should link to the central library.

### Screen layout

- Everyday sidebar: **Dashboard / Compliance Activities / Equipment / Documents / Inspections / Actions / Reminders**.
- Bottom of sidebar: **Admin / Setup** containing **People/Users**, **Core Data (Area > Site > Room)**, **Compliance Types**, **Settings**.
- Dashboard + Activities register are the focus: filter and sort by cascading Area > Site > Room, Type, due date, equipment, user, status; text search; clicking row opens Activity detail.
- Detail shells show Overview & Schedule / Linked Equipment / Documents / History / Actions. Site front sheet shows related compliance records and their documents.
- Service Charges is a labelled Phase 2 discovery placeholder only.

### P0 vertical slice (show this works)

1. Migrate/refactor any incomplete old `properties` and `property_checks` files to v0.3, do not keep flat schema merely because it was already generated.
2. Seed 2 fictional Areas, 10 fictional Sites, useful Rooms + Equipment, five Compliance Types, Compliance Activities and links. IDs `PH-A001`, `PH-S001`, `PH-R001`, equipment `PH-E001`; no personal or real address data.
3. **Admin Core Data**: create/edit Area, Site under Area, Room under Site. Admin People/Users directory records, and editable five-type catalogue with Add Type.
4. **Compliance Activities**: create type + one location (Area, Site or Room), optional equipment from in-scope Rooms, schedule/owner, edit/save and searchable/filterable register.
5. **Document Library**: upload dummy file once, link it to Site, Equipment and Activity; show all links. Uploaded file is not verified until operator ticks Reviewed/Verified.
6. **Manual Recalculate**: statuses reflect latest dates/evidence/critical actions **only when clicked**; stale/pending indicator after save; all snapshots persist in SQLite. Europe/London date semantics; due today amber, overdue tomorrow.
7. **Reminders**: generated on Recalculate and visible as editable drafts; separate manual send/export control with demo adapter / `.eml`; zero real sends. Simple duplicate protection.
8. Deliver working UI, build/test evidence and a one-command startup README. Do NOT stop at a schema or code skeleton.

P1: complete 30-point inspection runs, actions, exports and richer document history. P2: service charges, requirements pending.

### Execution boundaries

Build, edit, install needed local packages, run scripts/tests and commit local work without repeated confirmation. **Do not push to GitHub, open PRs, deploy externally, send real mail or alter other projects** without further instruction. Keep Remote Control for Property Hub running independently; do not stop other Claude jobs or infrastructure.

**Acceptance-critical end-to-end route:** Admin > Area/Site/Room > Equipment > New Compliance Activity > Link equipment > Upload once and link document in two contexts > Save > Dashboard shows pending > Recalculate > Dashboard RAG > Reminder preview / draft export. If the UI cannot demonstrate this, P0 is incomplete.
