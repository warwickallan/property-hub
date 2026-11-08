# Property Hub — Lightweight single-user specification

**Version:** 0.2 | **8 November 2026** | **Status:** build brief, not production approval  
**Prepared for:** the project owner, the operator and Opus | **Source:** the organisation Compliance Officer request + `New H&S checks all areas.xlsx`

> **Design decision (superseding v0.1):** a simple **single-operator web app backed by SQLite**, with **manual compliance recalculation** and **operator-initiated email reminders**. No SharePoint backend, no multi-user portal, no always-on background scheduler and no enterprise security workflow in the MVP. This is a product brief, not an externally verified statement of the organisation's legal duties.

## 1. Goal and scope

One person can see each accommodation/property's health-and-safety file, enter inspection and certification dates, upload evidence, maintain the schedule, identify upcoming and overdue items on demand, and send reminders to team leaders by email. Keep things obvious, fast and usable. Service charges are a separate future discovery item.

**A normal operating session:** open Property Hub → enter new certificate dates or update inspection → save → click **Recalculate compliance** → review red/amber/green/grey dashboard → review reminders → click **Send selected reminders** or export drafts → finish. The database persists saved records, but **statuses do not silently refresh** while the application is idle or after edits.

**Not in v0.2:** multiple interactive users, assignee dashboards/portals, approval chains, daily scheduled tasks, live syncing, third-party cloud systems, SSO, Power Automate, SharePoint, accounting integration, automated benefit calculations, real public deployment, phone apps or AI document understanding.

## 2. Source content: keep source and interpretation separate

The attached spreadsheet has **30 routine H&S visual checks**, in five groups: Fire Safety (8), Security (4), Gas/Electrical & Utilities (5), Health & Wellbeing Risks (6), and General Property Safety (7). It is a **checklist**, not a list of legal testing frequencies or evidence of passed inspections. `inspection_template_seed.json` contains the exact question texts and provenance; import directly. An unchecked source box is unanswered, not a failed result.

Separate data types:
- **Compliance obligations/certificates** — e.g. gas checks, fire risk assessments, PAT, Legionella, electrical EICR, and additional configurable checks.
- **Routine inspection runs** — answers to the 30 workbook questions, which can raise actions.

Do not automatically turn a visual inspection Pass into a certified gas, EICR, FRA or Legionella compliance record.

## 3. User model

Exactly **one local operator** in MVP. Their name is configurable; no login screen needed for an offline/localhost prototype. Teams/leaders are **email contacts only** (name, email address, optional team). The operator assigns contacts to properties/checks, but **contacts cannot access or change the app**. No role-based permissions, staff management screen, password-reset system or guest sharing to build.

Because refuge information may be sensitive, use fictional property codes (`the organisation-P001`) in seeded/demo data and minimal property details in emails. Do not populate or upload live locations, clients or confidential case notes into unapproved hosting or external developer services. If moving beyond local prototype, agree hosting, backups and basic access protection then; do not make them blockers now.

## 4. Pages and user stories

### 4.1 Dashboard (home)

Top row: property count, checks green, amber due soon, red overdue/at-risk, grey unknown, open actions. Underneath: filterable/sortable matrix of property code, check type, last checked, next due, days until due, status, team leader, evidence indicator. Filters by property, category, status, team leader and due range. Click any row to edit the relevant property/check.

**Prominent toolbar:** `Recalculate compliance` primary button, `Last calculated <date/time>` label, `Changes pending recalculation` badge after any edit. **Do not** silently recalculate on reload, midnight, save or navigation. The visible status is a stored snapshot with a timestamp, not a pretend live status. Source due dates remain visible even when the snapshot is stale.

States (badges have both colour and text):
- **Green — Up to date:** applicable evidence/inspection is recorded and in date, and no open serious issue blocks it.
- **Amber — Due soon:** next due is within configurable warning window (default 30 days), not yet overdue.
- **Red — Overdue / at risk:** next due has passed, a critical unresolved issue is recorded, or a recorded expiration invalidates evidence.
- **Grey — Unknown / missing:** missing date, missing/unverified document where configured as required, or applicability has not been decided.
- **Not applicable:** operator has explicitly marked it N/A with a short reason; excluded from compliance rate, shown separately.

Date calculations should use calendar dates in `Europe/London` and clear inclusive rules (due today => amber unless a more serious condition applies; overdue begins tomorrow). Keep default warning threshold editable at check-type level or system setting. Handle month/year rollover and leap day. For checks with their own date from a certificate, allow operator to enter it; never force every category to be annual.

### 4.2 Properties

A searchable register: code (unique), short safe label, type, responsible email contact, active/inactive, notes (do not use for safeguarding details). Add/edit/archive properties. Each property has a **front-of-folder overview**: check type, last check date, status (as of last manual recalculation), next due, days remaining, evidence links, contact and open action count.

Tabs: **Overview / Compliance / Inspections / Documents / Actions**. Keep navigation shallow. No maps, assets hierarchy, occupancy records, room registers or additional roles. Printable front sheet and CSV export are useful stretch goals.

### 4.3 Compliance register & certificates

Editable catalogue of types seeded with PAT, FRA, Gas Safety, Legionella, EICR and Other. For each property/type store: applicable yes/no/unknown; recurrence policy (months OR a manually entered next due); last completed date; next due date; optional expiry date; status snapshot; team leader; remarks; supporting documents. Support multiple historical evidence uploads and mark one as current; old files stay linked. Accept PDFs/images with file size/type guard; store bytes under private local folder, metadata in SQLite. Link documents by ID, not user-supplied filename path. Include a simple `Reviewed/verified` checkbox controlled by the sole operator (not a separate approval workflow). Basic versioning is enough.

**Do not invent law:** default categories are a working list, and intervals must be editable/confirmed by the organisation's Compliance Officer. Gas annual in many relevant contexts; PAT, FRA and Legionella do not have a universally applicable annual certificate rule. Different property arrangements may have different duties.

### 4.4 Routine inspections

Select property and date, answer each of the **30 supplied checks** with `Pass`, `Issue`, `Not applicable`, or `Not checked`, plus short notes. Save draft / mark complete. Any `Issue` may generate an action with title, priority, owner email contact, due date, state. Maintain inspection history by property. Prefer a straightforward desktop/mobile form; don't build complex routing/review stages. Do not add occupant names or safeguarding incident details into general inspection notes.

### 4.5 Actions

Simple list: property code, source (inspection item or certificate issue), description, priority, assigned contact, due date, status (`Open`, `In progress`, `Done`), closed date and notes. Edits may flag the dashboard snapshot as requiring recalculation. An open `Critical` action can make the linked check red when next calculated. No kanban, SLA engine, approvals or escalation workflow.

### 4.6 Reminders (manual operation only)

`Recalculate compliance` **calculates and stores** dashboard status snapshots AND produces a candidate list of reminders that can be reviewed. Candidate criteria: by default due within 30/14/7 days and overdue, all configurable. Recipients are team-leader contacts stored against properties/checks; missing email shows `No recipient` and cannot send.

Reminders screen: due item, property code, check, due date, days left, recipient address, whether a reminder has already been sent. Operator can **select**, **preview**, **edit a short optional message**, then click **Send selected reminders**. **Nothing sends merely because Recalculate was clicked.** Provide `Export .eml drafts` or demonstrative outbox while real mail is unconfigured. One email per recipient grouping multiple properties/checks is optional; simpler one-per-item acceptable.

Sending connector: small adapter (SMTP or Microsoft Graph) configured separately through environment variables, never embedded credentials; provide an in-app test-connection capability only if straightforward. Do not block the working prototype on Microsoft authentication. Record sent at, recipient, subject, check/date, outcome and error; avoid duplicates for `(property, check, due date, reminder threshold, recipient)` unless operator explicitly chooses `Resend`. Sending is a manual button and does not require an always-running scheduler.

Email text uses code/reference, type, due date and instruction to contact the Compliance Officer, **not refuge addresses, resident details, personal circumstances or document attachments**.

### 4.7 Service charges

Show a small `Service Charges — future module` page with a short discovery questionnaire, **not** fabricated charge calculations or accounting records. Questions: what charges are recorded, whether per property/room/person/period, what source spreadsheet or finance system exists, who approves rates, what reports are required. Build this after the operator clarifies the scope.

## 5. Data schema (minimum practical design)

Use SQLite with migrations. Tables can be named freely; keep relationships and historical snapshots clear:

| Table | Main fields |
|---|---|
| `properties` | id, code, label, property_type, contact_id, active, notes, created_at, updated_at |
| `contacts` | id, name, email, team, active |
| `check_types` | id, name, category, default_warning_days, suggested_interval_months_nullable, evidence_required, active |
| `property_checks` | id, property_id, check_type_id, applicability, na_reason, last_checked_on, next_due_on, expires_on, contact_id, notes, updated_at |
| `documents` | id, property_id, property_check_id_nullable, stored_filename, display_filename, mime_type, uploaded_at, issued_on, valid_until, verified_by_operator, current_flag |
| `inspection_runs` | id, property_id, inspected_on, state, completed_at, notes |
| `inspection_answers` | id, run_id, question_code, response, notes |
| `actions` | id, property_id, property_check_id_nullable, inspection_answer_id_nullable, title, priority, contact_id, due_on, status, closed_at |
| `recalculation_runs` | id, started_at, completed_at, status_counts_json, warning_config_json |
| `check_status_snapshots` | run_id, property_check_id, status, days_remaining, calculated_due_on, reason |
| `reminder_candidates` | id, run_id, property_check_id, recipient_email, threshold, due_on, draft_body, selected, last_sent_at_nullable |
| `email_log` | id, candidate_id, recipient_email, outcome, sent_at, message_key, failure_details |
| `settings` | key, value |

Implement simple referential integrity and indexes on property/check, due date and reminder key. Store **original source checklist text** in seeded template data or a `checklist_questions` table. Use SQLite transactions for batch recalculation and local backups. The application can use one combined server rather than microservices.

**Manual calculation semantics:** `property_checks` contains editable source dates, while `check_status_snapshots` contains the **last calculated results**. Any write affecting calculations sets `settings.recalculation_pending=true`. Clicking the manual button creates one new run, writes snapshots and reminder candidates, records completion, then clears pending. Reopening the app shows that run unchanged until the operator recalculates again. If there has never been a run, show `Not yet calculated`, never fake green tiles. No timer, cron, scheduled queue or automatic recomputation.

## 6. Suggested technology and deployment posture

**Build local MVP:** React + Vite + TypeScript, a small Node/Express API, SQLite (`better-sqlite3` if supported), filesystem uploads in e.g. `./data/uploads`, plain CSS/Tailwind at Opus' discretion. Development binds to localhost. Prefer single `npm run dev` command, and production-like local `npm start` after a build. Keep `.env.example`, SQLite migration/seed scripts and readable README. This can run on a normal PC or one local server; don't use a cloud database or serverless platform requiring external persistent-volume workarounds.

**For real data later:** choose where the organisation runs it, how to back up SQLite and uploaded files, who can access the machine, and how to send authenticated email. Keep a short `GO_LIVE_NOTES.md` list. **This is not a request to build tenancy, GDPR compliance suites, audited RBAC or MFA today.** A localhost demo with fake data is sufficient for Phase 0. No real external emails without the project owner's explicit approval.

## 7. UX: deliberately boring in the good way

Desktop-first but mobile-readable. A simple sidebar: **Dashboard / Properties / Inspections / Actions / Reminders / Service Charges / Settings**. Property detail is a front-of-folder screen. Dates should accept `dd/mm/yyyy` display and ISO storage, show `X days remaining` or `X days overdue`. Make editable fields obvious and limit clicks. Text labels as well as RAG colours. Every dashboard view shows last manual calculation date. Keep the interface useful even if emails are never configured.

## 8. Acceptance tests (must demonstrate)

1. Add a fictional property; save; refresh browser; record persists in SQLite.
2. Add a gas check due 20 days away; **before clicking Recalculate**, the status snapshot is unchanged and a `Changes pending recalculation` badge appears.
3. Click `Recalculate compliance`; the due-soon check is amber, `Last calculated` updates and pending badge clears.
4. Move due date to yesterday and save; snapshot remains amber until next manual recalculation; then becomes red.
5. Missing or operator-unverified evidence when evidence is required makes check grey; the single operator can mark a document `Reviewed/verified` manually. Uploading a file alone never changes the status to green.
6. Reminders appear as candidates on manual run; **zero emails** are sent from recalculation itself.
7. Selecting and sending reminders calls demo email adapter (or exports `.eml` drafts); log shows what happened, errors are visible, repeat sends require explicit override.
8. Team-leader contact receives an email in the configured test adapter, but has **no login/portal**.
9. Import exactly 30 workbook questions and preserve question wording; not-checked is not Pass.
10. Inspection Issue can create an action; linked Critical action makes check red on next manual run.
11. N/A removes item from compliance denominator but displays the reason.
12. The app shows `Not yet calculated` before first run and has no background scheduler, periodic auto refresh or midnight changes.
13. Certificate upload/download works locally with SQLite metadata and private file storage; the original stays available in history.
14. Service Charges is clearly labelled discovery/Phase 2, without made-up resident billing data.

## 9. Build and review workflow

**Priority P0:** actual working path Dashboard → Property/Check → Edit evidence or date → Save → **manual Recalculate** → Reminders Preview → **manual Send/Export**.  
**P1:** routine inspections, actions, useful exports, quality-of-life refinements.  
**P2:** service charges after clarification; optional live hosting, staff access or automation only if requested later.

Ship the P0 path before creating extra architecture diagrams, approval gates, review agents or test harnesses. Report blockers only when an actual dependency is unavailable. Deliver code, setup instructions, seeded demo, short tests, working demonstration and plain-English known limitations.

## 10. Later questions (NOT build blockers)

How many properties? What actual check types and intervals do they use? What inspection frequency is used for the 30-point checklist? Who receives each reminder and at what lead time? Does the operator prefer individual emails or one digest per team leader? Where will the application eventually run? What service-charge spreadsheet exists? These can be configured or discovered after the working first cut.

**One-line build mandate:** Deliver a single-user mini-Concerto compliance dashboard with SQLite, manually recalculated RAG status and manually triggered reminder emails. Nothing more until this works.