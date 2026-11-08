# Property Hub — v0.3 Information Architecture, Screens & Data Model

**Date:** 2026-11-08  
**Status:** Product-owner design direction. **Supersedes conflicting parts of v0.2** in PROPERTYHUB_BUILD_SPEC.md and the earlier kickoff.  
**Purpose:** Concerto-style PPM foundations without a Concerto-sized application.

## 1. Product model

Build a single-operator web app (initially) whose everyday experience is **Dashboards + filterable registers + record detail**. Move configuration and reference records into **Admin / Setup**. Users/contacts can be managed as records now; no full multi-user login, RBAC, SSO or approval flow in P0.

**Hierarchy (mandatory):**
- **Area** has many **Sites**.
- **Site** belongs to exactly one Area and has many **Rooms**.
- **Room** belongs to exactly one Site.
- **Equipment** belongs to exactly one Room (never directly to a Site or Area).
- **Compliance Type** is a configurable catalogue, seeded with exactly these 5: PAT Testing, Fire Risk Assessment (FRA), Gas Safety, Legionella, Electrical Installation Condition Report (EICR). More types can be added in Admin.
- **Compliance Activity** is a *scheduled obligation* linking exactly one Compliance Type to exactly one location at level **Area OR Site OR Room**. A user picks the level deliberately. Each activity stores schedule, evidence requirement/verification, responsible person, and last manually calculated status.
- **Equipment Link** is a many-to-many link between Equipment and Compliance Activities. A compliance activity may cover zero, one, or many pieces of equipment; the same equipment can be linked to multiple activities. Candidate equipment must live inside the selected activity's location scope (room/site/area). For example: PAT at a Site can cover multiple items across its Rooms; a Room-level check cannot link kit from another Room.
- **Document** is uploaded once to a *central private local file store* and can be linked to multiple Areas, Sites, Rooms, Equipment, Compliance Activities, Inspection Runs, or Actions. The app shows linked files from each relevant detail view, without duplicating file bytes.

**Keep the distinction:** Compliance Type = *what kind of obligation*; Activity = *where it is due, how often, and current dates*; Equipment Link = *which items that specific activity covers*; Inspection/Visit = *what was actually done on a given date*; Document = *evidence*.

## 2. Navigation: user experience first

Left sidebar (everyday): **Dashboard | Compliance Activities | Equipment | Documents | Inspections | Actions | Reminders**. A compact **Admin / Setup** gear entry at the bottom (not a busy enterprise admin portal). Service Charges remains a subdued Phase 2 placeholder.

Global header: breadcrumb, **active Area/Site filter** (optional), search, **Recalculate Compliance** button, last calculation timestamp, and a clear **Changes pending recalculation** indicator.

The default screen is **Dashboard**, never Admin. Make registers first-class with quick search, column sorting, status/due filters, column count and one-click record opening. Display `dd/mm/yyyy`, store ISO calendar dates, use Europe/London local day boundaries.

### Screen A — Dashboard (home)

- KPI row: total Sites, total Activities, compliant, due soon, overdue/at risk, unknown, open actions.
- Filter bar: **Area -> Site -> Room**, Compliance Type, Equipment, Responsible User, Status, Due from/to, text search. Cascading: changing Area clears invalid Site/Room selections.
- Main table (default): Activity Ref / Area / Site / Room-or-Site scope / Compliance Type / Activity Name / Equipment count / Last done / Next due / Days to due / Status / Responsible / Verified Evidence indicator / Action count.
- Row opens **Activity Detail**. Clicking Site opens Location Detail. Keep RAG + text statuses, no chart needed until actual data justifies it.
- Secondary quick views/tabs: **All | Overdue | Due Soon | By Location | By Type | Missing Evidence**. These are filtered views over one consistent source, not six bespoke pages.
- **Snapshots only change on explicit Recalculate**; saving edits marks changes pending without changing old status. Before first run: **Not yet calculated**.

### Screen B — Compliance Activities Register (primary working register)

- Same rich filters as dashboard plus applicability, interval and evidence state.
- Primary **New Activity** action: (1) select Compliance Type; (2) select level Area/Site/Room and a specific location; (3) optional name/reference, responsible user, interval or manual next due; (4) optionally link existing equipment; (5) optionally link/upload documents; save.
- Activity Detail is a compact record page with tabs/sections: **Overview & Schedule | Linked Equipment | Documents | Inspections / History | Actions**.
- On Overview show type, location breadcrumb, last checked, next due, expiry if applicable, intervals, status snapshot, reason, responsible contact, verification, and notes.
- An Activity may be location-wide with **zero** linked equipment (e.g. site FRA); don't force equipment creation.
- Equipment links searchable by asset tag, type, room; add/remove without deleting asset or activity.
- Archive records; don't hard-delete linked history. Check intervals are *configurable*, not claims of law.

### Screen C — Location browser (drill-down, mainly configured under Admin)

- Hierarchical list/tree **Area > Site > Room**; a row opens Location Detail, which displays its breadcrumb, linked activities, equipment in child rooms, linked documents, recent inspections and actions.
- Clicking a Site in the dashboard should give a "property front sheet" summarising activities due, missing evidence, and documents across that site; room-level drill-down available.
- A Site corresponds to an accommodation/property in the brief. Do not create a second redundant `properties` table.
- A Site may exist without rooms temporarily; don't invent rooms solely to create site-level compliance activities.
- Codes: `PH-A001`, `PH-S001`, `PH-R001`. All demo names/addresses fictional; no real addresses.

### Screen D — Equipment Register

- Filterable table: Asset Code / Description / Type or Category / Area / Site / Room / Serial (optional) / Status / Number of linked Activities.
- Equipment detail: details, immutable room relationship (editable room selection if moved), linked compliance activities, documents, optional notes. **Always choose Room when creating equipment.**
- Optional equipment creation from a Room detail; never direct equipment-to-Site membership.
- Movement of equipment between rooms must not silently make linked compliance activities inconsistent. Surface invalid links and prompt operator to review them.

### Screen E — Documents Library (one central store)

- File register: Document ID / Title / File Type / Uploaded Date / Issued On / Valid Until / Reviewed/Verified / Linked Records / Actions (open/download/link/unlink).
- Upload once to a private local `data/uploads` directory using generated safe storage IDs. SQLite records filename/title, MIME, size, checksum and path/storage key; server downloads through document ID, not arbitrary filesystem paths.
- **Link existing document** picker in Site, Room, Equipment, Activity, Inspection, or Action. One document can be linked to multiple records without re-uploading.
- **Add document here** in those screens uploads once and immediately creates an association with the current record.
- Separate `documents` and `document_links` tables; server validates linked entity exists. No copies of the same file for every linked entity; historical/replaced versions retain their records.
- **Upload is not verification.** Review/verified toggle is a separate manual field and only verified evidence satisfies an activity rule if evidence is required.
- The location/activity document panels should show **direct links** clearly; optionally show labelled documents from parent locations (without confusing indirect association for direct association).
- No public URL, no real client documents, no external upload service. Never commit uploaded files/SQLite DB to Git.

### Screen F — Inspections / Actions / Reminders

- **Inspections:** select a Site (and optional Room) and perform the exact 30-question routine inspection form imported from JSON. Store individual runs and answers with history. An Issue can create a linked Action. These inspections **do not** automatically substitute statutory evidence.
- **Actions:** filterable list with source Activity/Inspection, priority, owner, due date and state. Open Critical Action linked to an Activity causes that Activity to be red at the **next manual Recalculate**.
- **Reminders:** review candidates generated **only** on manual Recalculate. Select/preview and manually demo-send or export `.eml`; duplicate guard, logs. No automatic mail, scheduler or background task.
- **Service Charges:** Phase 2 placeholder only.

## 3. Admin / Setup screens (one admin operator initially)

Use a straightforward subnavigation:

1. **People / Users:** add, edit, disable staff records; name, email, optional team, role label (Operator / Team Leader / Contact), active. **Only one person logs in/uses the MVP; everyone else is a contact/reminder recipient.** No login invitations, passwords, self-service access or access-control engine yet. Preserve ability to add real accounts later if separately requested.
2. **Core Data:** manage Areas, Sites and Rooms in a three-column cascading editor or expandable tree; Add/Edit/Archive, uniqueness and required parent. Show child counts and block destructive parent deletion while children are linked.
3. **Compliance Types:** seed 5 types above; Add/Edit/Archive custom types; code, label, optional default interval, default warning days, evidence required, active. Do not hard-code all schedules to one interval.
4. **Settings:** warning-day defaults, demo email mode, manual reminder thresholds, backup/export guidance. No background run toggles.

### Suggested simple screen skeleton

```text
PROPERTY HUB      [ Area: All v ] [ Search... ]   [ Recalculate ]   [ Settings ]
                       Last calculated 08/11/2026  |  Changes pending

Dashboard                 [KPI: Overdue] [KPI: Due soon] [KPI: Unknown]
Compliance Activities     [Area v] [Site v] [Room v] [Type v] [Status v]  [Search]
Equipment                 ----------------------------------------------------------
Documents                 Activity | Site | Room | Type | Due | Status | Equipment
Inspections               ----------------------------------------------------------
Actions                   PH-C001    PH-S001 --   FRA     19/11   AMBER     0
Reminders                 PH-C002    PH-S002 R03  PAT     04/11   RED       5
----------------------
Admin / Setup (gear)
  People / Users
  Core Data
  Compliance Types
  Settings
```

Do not mimic Concerto's complexity. Use reusable filterable tables, straightforward add/edit forms, a record detail shell and link picker throughout. Aim for few clicks and excellent scannability.

## 4. SQLite relational model — v0.3 schema

Prefer robust foreign keys and migrations. These tables supersede `properties` / `property_checks` in v0.2:

| Table | Key fields / relationship |
|---|---|
| `users` | id, name, email, team, role_label, active. Directory/contact only in MVP |
| `areas` | id, code unique, name, active |
| `sites` | id, area_id FK required, code unique, name, active, notes |
| `rooms` | id, site_id FK required, code unique, name, active |
| `equipment` | id, room_id FK required, asset_code unique, description, category, serial_no nullable, active, notes |
| `compliance_types` | id, code unique, name, suggested_interval_months nullable, warning_days, evidence_required, active |
| `compliance_activities` | id, ref unique, type_id FK, name, location_level ('area'/'site'/'room'), area_id/site_id/room_id nullable with CHECK enforcing **exactly one** location FK appropriate to level; owner_user_id nullable; last_done_on, next_due_on, expires_on, interval_months nullable, applicability, na_reason, notes, archived_at |
| `activity_equipment` | activity_id FK, equipment_id FK, composite unique; app validates equipment room is within activity scope |
| `documents` | id, display_name, storage_key, original_filename, mime_type, size_bytes, sha256, uploaded_at, issued_on, valid_until, verified_by_operator, supersedes_document_id nullable |
| `document_links` | id, document_id FK, entity_kind, entity_id, link_role, created_at; **validate entity existence** in API; unique(document_id, entity_kind, entity_id, link_role) |
| `inspection_runs` | id, site_id FK, room_id nullable FK, inspected_on, state, completed_at, notes |
| `inspection_answers` | id, run_id FK, question_code, response, notes |
| `actions` | id, activity_id nullable FK, inspection_answer_id nullable FK, site_id FK, title, priority, owner_user_id nullable, due_on, state, closed_at |
| `recalculation_runs` | id, created_at, totals_json, config_json |
| `activity_status_snapshots` | run_id FK, activity_id FK, status, days_to_due, reason |
| `reminder_candidates` | id, run_id FK, activity_id FK, user_id FK nullable, recipient_email, threshold, due_on, draft_text, selected |
| `email_log` | id, candidate_id FK, message_key unique, recipient_email, outcome, sent_at |
| `settings` | key, value |

Use strict FK enforcement, indexes on parent and due columns, and transactions for manual recalculation. If adding a new relation for evidence verification, keep it simple. SQLite is the central data model; local files are only document bytes.

**The status owner is the Compliance Activity**, not the Compliance Type, Site or Equipment. Rollup dashboards may aggregate activities by site/type/equipment without duplicating status as separate mutable records.

## 5. Workflows and acceptance tests

**A. Admin:** Create Area "North"; add Site "Demo House 01"; add Rooms "Kitchen" and "Office"; add Equipment "Kettle 001" to Kitchen. Linkage intact on browser reload.

**B. Scheduled activity:** Create Compliance Type "PAT" (seeded); create Activity "PAT 2027" scoped to Site "Demo House 01"; link Kettle 001; enter next due. Activity appears in area/site filtered register and Site front sheet, with Equipment count 1.

**C. One document, several contexts:** Upload `sample-certificate.pdf` from Activity details, link that same document to Kettle 001 and Site without creating a second file; document library displays all three links, and each record shows it.

**D. Calculation:** Update an Activity due date; save source data without changing last status snapshot, show pending banner; click Recalculate to update activity status and reminder candidates. Due today => amber, yesterday => red; missing required verified evidence => unknown if otherwise not red. No background update.

**E. More types:** Create new "Emergency Lighting" Compliance Type in Admin; create activity for a Room; it appears in filters/dashboard and persists, no developer changes required.

**F. Users:** Add a Team Leader record in Admin, assign them to an Activity, see them as reminder recipient. No new interactive login is provisioned.

**G. Equipment scope:** Attempt to link equipment from another Site to a Room-scoped activity; API rejects with understandable message.

**H. Filters:** Area -> Site -> Room plus Type, Status and text filters work together in dashboard and register. Back navigation retains reasonable context.

## 6. Build priority and explicit prohibitions

**P0 first:** SQLite migrations for v0.3 relationships, seed 2 fictional areas / 10 fictional sites / sample rooms / equipment / five types / activities; Admin core-data and types editor; Activity register with cascading filters and create/edit; Dashboard manual Recalculate and reminder draft preview; document library + reusable links where feasible. A convincing integrated vertical slice beats disconnected placeholder screens.

**P1:** full 30-question inspection workflow, Action register, rich document revision/history and exports.

**P2:** service charges after requirements are known.

Do not make auth/role engines, multi-user access, audit microservices, cron, auto emails, hosted storage, SSO or complex deployment prerequisites. Local-only, manual operations and fictional data remain unchanged.

**IMPORTANT:** An earlier Opus run began generating backend files from the obsolete flat `properties/property_checks` schema. **Refactor or replace those files; do not preserve the obsolete schema merely because it exists.** Validate that UI navigation, database relations and document links match v0.3 before calling the app built.
