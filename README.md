# Property Hub

A local-first, **single-operator property compliance tracker** (v0.5.0, "V2 workflow"). It separates two things:

- **configuring recurring obligations**, which happens in Admin: Compliance Types → Checklists → Compliance Activities;
- **doing the work**, which happens in Inspections / Visits → Remedials → evidence → closure.

Statuses only change on a **manual Recalculate**. All data is fictional.

```
Area → Site → Room → Equipment
Compliance Type → Checklist Template → Compliance Activity → Inspection / Visit → Remedial(s)
```

## Run it (one command)

Requires Node 20+.

```bash
npm install && npm start
```

Then open **http://localhost:3001**. On first start the app creates `data/propertyhub.db` and seeds fictional demo data:

- 2 Areas, 10 Sites, rooms and equipment;
- the five statutory types plus a routine visual-inspection type, with five routine checklists;
- 77 activities;
- visits in every lifecycle state.

The server listens on 127.0.0.1 only. It has no authentication.

| Command | Purpose |
|---|---|
| `npm start` | Build the UI and serve app + API on :3001 |
| `npm run dev` | Hot-reload dev mode (UI :5173, API :3001) |
| `npm test` | Unit/API tests (Vitest, in-memory DB): 54 tests |
| `npm run e2e` | Build, start on a throwaway data folder, run the P0, P1, scheduling and V2 browser journeys in headless Chrome |
| `npm run check` | Typecheck + tests + build + browser journeys |
| `npm run seed` | **Reset** the database to fresh demo data |

`PH_DATA_DIR`/`PORT` override the data folder and port. `CHROME_PATH` selects the browser for e2e. Output goes to `e2e/output/` (git-ignored). Curated evidence is in [docs/screenshots](docs/screenshots) and [docs/e2e-results.txt](docs/e2e-results.txt).

## Portable Windows ZIP (no admin rights)

See [docs/PORTABLE_WINDOWS.md](docs/PORTABLE_WINDOWS.md). Build with `portable/build-windows.ps1 -OutputFolder <folder>`. To smoke-test an extracted ZIP, run `runtime\node.exe portable\smoke-windows.mjs <folder> [--upgrade-from <previous release>]`. Operational data lives in `%LOCALAPPDATA%\PropertyHub\data`, outside the app folder.

## The workflow

**Daily work.** The main menu is Dashboard · Inspections / Visits · Remedials · Equipment · Documents · Reminders.

1. **Dashboard**: operational due work and compliance status.
   - Filter by Area › Site › Room, type, status, responsible person, due dates, visit state, remedial state and evidence state.
   - Each row has **Start visit** or **Open PH-V…**.
2. **Inspection / Visit**: one occurrence of a Compliance Activity.
   - It records the performed date, inspector and/or provider, notes, the activity's checklist answers (Pass / Issue / Not applicable / Not checked, plus notes), remedials and evidence documents.
   - The checklist **questions and version are frozen** into the visit. Later edits to the checklist never change history.
3. **Complete Inspection** records the work outcome: *Inspection Complete* or *Inspection Complete with Remedials*.
   - It updates the activity schedule: next due = performed date + interval, unless you set a reasoned override.
   - It does **not** make the activity compliant.
4. **Lifecycle**: Scheduled / In Progress → Inspection Complete / Complete with Remedials → Awaiting Evidence → Closed.
   - Completion time and closure time are stored separately.
5. **Close Inspection** is disabled, with the blocking items listed, until all of these hold:
   - the work is complete;
   - every remedial is Done;
   - if the Compliance Type has **Evidence / Certificate required** ticked, a linked document is explicitly marked **Reviewed/Verified**. Uploading alone never counts.
6. **Automatic closure from remedials**:
   - When the final remedial is Done and no paperwork is outstanding, the visit **closes automatically**.
   - If paperwork is still missing or unverified, it moves to **Awaiting Evidence** instead.
   - A visit completed without remedials is closed manually.
7. **Reopening**, of the work or of a closure, needs a reason. It is recorded in the visit's timeline.
   - Evidence of a closed visit cannot be unlinked or un-verified.
   - Reopening the work restores the schedule the visit had set.
8. **Remedials** (formerly Actions):
   - Each belongs to a visit, and optionally a checklist question, room and equipment.
   - The lifecycle is Open → In progress → Done, and Done needs closure details.
   - An open **Critical** remedial makes its activity red at the **next** Recalculate. Resolving remedials never recalculates RAG on its own.
9. **Recalculate Compliance** (header) is the only thing that changes RAG. Saves, completions and closures show *Changes pending*.

**Activity status vs inspection status.** These are separate, and the status reasons say which applies:
- Overdue (this always wins)
- Inspection complete with remedials outstanding
- Awaiting required evidence
- Inspection complete, not yet closed
- Compliant / verified
- Not applicable / unknown

A still-unclosed newer visit never makes an activity look compliant.

**Activity history.**
- *Inspection history* (default) lists the actual visits, latest first.
- *Schedule changes* shows each change before → after, with its source.
- *Calculation history* collapses identical Recalculate runs and shows full timestamps.

**Admin / Setup.**
- **People / Users**
- **Property Details** (Area › Site › Room)
- **Compliance Types**, including the *Evidence / Certificate required* checkbox
- **Checklists**: create, edit, duplicate, reorder, archive; questions are mandatory or optional; every change bumps the version
- **Compliance Activities**: type, checklist of that type, one location, interval, responsible person, calculated next due or reasoned override
- **Settings**

**Routine checklists.** The 30 original questions are imported verbatim as five checklists (Fire Safety 8, Security 4, Gas/Electrical/Utilities 5, Health & Wellbeing 6, General Property Safety 7). They sit under a configurable *Routine Property Inspection (visual)* type, with no certificate requirement. They are not mapped onto PAT/FRA/Gas/Legionella/EICR. Each routine activity has its own schedule.

**Also included:**
- **Exports**: CSV of the filtered activities, remedials and completed visit results.
- **Printable Site front sheet**.
- **Reminders**: drafts only (demo outbox / `.eml`). Nothing is ever really emailed.

## Upgrading existing databases

Migration 3 is additive and runs automatically.
- **Schedules:** stored dates are preserved. A stored next due that differs from last done + interval is kept as a labelled **Override**.
- **Routine inspections:** v0.3 routine 30-point inspections are copied into visits with the **same ids and refs**, so document links stay valid. Their answers and remedial links are kept. They are **not** attached to an activity and are **flagged "Needs review"**. Link each one from the visit page.
- **Old records:** the original tables are kept untouched.
- **Standalone actions:** these become remedials flagged for review. They keep their activity link.

## Not built yet
- Service charges (P2 placeholder).
- Document version/revision UI.
- PDF export (use Print → Save as PDF); Equipment/Documents CSV.
- Per-question evidence attachments: evidence is linked to the visit as a whole.

## Specs and data boundaries

The specs are [docs/OPUS_START_HERE.md](docs/OPUS_START_HERE.md) and [docs/PROPERTYHUB_UI_DATA_MODEL_V03.md](docs/PROPERTYHUB_UI_DATA_MODEL_V03.md). V2 changes are in this README.

The repository is source control, **not a document vault**. `data/propertyhub.db`, `data/uploads/`, `data/outbox/` and `e2e/output/` are git-ignored. Pushing, deployment and real email require explicit instruction from the project owner.
