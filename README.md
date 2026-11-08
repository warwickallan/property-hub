# Property Hub

A local-first, **single-operator property compliance tracker** (v0.3). Area › Site › Room › Equipment hierarchy, scheduled Compliance Activities, one central document library with reusable links, **manual** compliance recalculation, and reviewable reminder drafts. Fictional demo data only.

## Run it (one command)

Requires Node 20+.

```bash
npm install && npm start
```

Then open **http://localhost:3001**. The first start creates `data/propertyhub.db` and seeds fictional demo data (2 Areas, 10 Sites, rooms, equipment, five compliance types and 51 activities). The server listens on 127.0.0.1 only. It has no authentication and must not be exposed on a network.

| Command | Purpose |
|---|---|
| `npm start` | Build the UI and serve app + API on :3001 |
| `npm run dev` | Hot-reload dev mode (UI on :5173, API on :3001) |
| `npm test` | API + calculation tests (Vitest, in-memory DB) |
| `npm run typecheck` | TypeScript check |
| `npm run seed` | **Reset** the database to fresh demo data |

`PH_DATA_DIR` and `PORT` override the data folder and port.

## What's in P0

- **Dashboard** (home): KPIs, cascading Area › Site › Room filters plus type, status, responsible, equipment, due range and search. Quick views: All, Overdue, Due Soon, By Location, By Type, Missing Evidence.
- **Compliance Activities**: register and create/edit. Each activity has one type and one location at Area, Site or Room level, with optional equipment that must be within that scope. Detail tabs: Overview & Schedule, Linked Equipment, Documents, History, Actions.
- **Equipment**: register and detail. Equipment always belongs to a Room. Moving it flags activity links that fall out of scope.
- **Documents**: each file is uploaded once to `data/uploads` and linked to any Area, Site, Room, Equipment, Activity or Action. Uploading does not verify a file. The operator ticks Reviewed/Verified separately.
- **Location detail / Site front sheet**: activities (direct and inherited), child rooms, equipment, direct and related documents.
- **Recalculate Compliance** (header button) is the only thing that changes statuses. Saves show "Changes pending recalculation". Dates use Europe/London: an item due today is amber and becomes red the next day. Missing required verified evidence shows as unknown. An open Critical action shows red.
- **Reminders**: generated only by Recalculate. Preview or edit drafts, export `.eml`, or demo-send to `data/outbox`. Includes a duplicate guard with explicit resend. **No real email is ever sent.**
- **Actions**: minimal register. **Admin / Setup**: People/Users (contacts only, no logins), Core Data editor, Compliance Types (Add Type), Settings.

**P1 (not built yet):** the 30-question inspection runs (the questions are imported and previewed under Inspections), full action workflow, exports. **P2:** service charges (placeholder).

## Specs

1. [docs/OPUS_START_HERE.md](docs/OPUS_START_HERE.md): build mandate
2. [docs/PROPERTYHUB_UI_DATA_MODEL_V03.md](docs/PROPERTYHUB_UI_DATA_MODEL_V03.md): authoritative v0.3 model
3. [docs/PROPERTYHUB_BUILD_SPEC.md](docs/PROPERTYHUB_BUILD_SPEC.md): legacy v0.2 (date and reminder detail)

## Data and boundaries

The repository is source control, **not a document vault**. `data/propertyhub.db`, `data/uploads/` and `data/outbox/` are git-ignored. Back up by stopping the app and copying `data/`. Do not enter real addresses, residents or certificates. Pushing, deployment and real email sending all need explicit project-owner instruction.
