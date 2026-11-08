# Opus kickoff — Property Hub v0.2 (single-user, manual run)

**Read this before anything else. It supersedes v0.1's SharePoint, multi-user and background-job architecture.**

Build a **working, simple, local-first web application** for the operator / one the organisation Compliance Officer to manage property compliance. This is NOT a multi-user CAFM system. The source requirements are the officer's brief and the attached workbook. Use `PROPERTYHUB_BUILD_SPEC.md` for detailed behaviour and `inspection_template_seed.json` for the exact 30 source checklist questions.

## Hard decisions — do not re-open them or over-engineer

- **One operator** manages the entire property register. Other team leaders **receive emails**; they do not log in, edit records, use workflows or need accounts.
- **Web app + SQLite**, not SharePoint, Power Apps, SQL Server, Supabase or a cloud database. Suggested stack: React + Vite + TypeScript UI, Express + TypeScript API, `better-sqlite3` (or equivalent) and a local private uploads folder. A single Node service can serve both built UI and API.
- **No cron, workers, scheduled polling, real-time events or always-on recalculation.** Implement one prominent **`Recalculate compliance`** button. Recalculate from saved data and today's date ONLY when clicked. Show `Last calculated: …` and `Changes pending recalculation` after edits. Data saves are immediate, but the dashboard's computed status remains the last snapshot until another manual run.
- Recalculation also produces a **reminder preview/queue**. A separate **`Send selected reminders`** button sends emails **only on operator command**, after review. If no email connection is configured, offer downloadable `.eml` drafts or a safe preview instead of claiming emails were sent.
- **No role system, staff portals, approval bureaucracy, SSO, MFA integrations, security audit framework, external deployment or legal-signoff blockers in the initial build.** Local prototype binds to `127.0.0.1`, uses wholly fictitious properties and addresses (prefer codes only), and avoids exposing private refuge data. Authentication/hosting decisions can be made separately when the app is actually used with live data.
- **No premature service-charge accounting product.** Provide a clearly labelled Phase 2 placeholder and a short discovery questionnaire; do not invent housing-benefit/billing rules.
- Inspection obligations and intervals are **configurable data**, not universally hard-coded legal claims. The 30 workbook questions are a routine inspection checklist, distinct from compliance certificates.
- You may build/test/edit local files without another permission request. Do **not** push GitHub, deploy publicly, connect to the organisation's environment, send real emails or spend money without the project owner's approval.

## Build order — ship the vertical slice first

1. Start the app locally with SQLite persistence and demo seed data (10 fictional properties). Provide a one-command development start.
2. Property register CRUD and property front sheets: last check, status, next check, countdown and documents.
3. Compliance catalogue (Gas, FRA, PAT, Legionella, EICR, other), required/not-applicable per property, editable frequency/next due, evidence upload metadata and private local file storage.
4. **Manual Recalculate**: deterministic red/amber/green/grey outcomes; persist run history; display last-calculated timestamp and changes-pending flag.
5. **Manual reminder queue**: determine what is approaching/overdue, preview grouped emails to team leaders, select items, send via configurable SMTP/Graph adapter only when explicitly triggered; otherwise export `.eml` drafts. Log attempts, successes, failures and prevent duplicate sends for the same property/check/due date/threshold/recipient unless manually overridden.
6. Import the EXACT 30 workbook inspection questions; simple Pass / Issue / N/A / Not checked, notes and optional action.
7. Actions list, document folder views, basic CSV export/print front sheet; service-charge Phase 2 placeholder.
8. Basic tests for date logic, persisted edits, manual-only recalculation, email-not-sent-without-click, duplicate prevention, inspection source integrity. Stop adding infrastructure once end-to-end works.

## Required working demo

Operator adds/edits a fictional property's gas check and uploads a dummy certificate → dashboard indicates `Changes pending recalculation` → operator clicks **Recalculate compliance** → due-soon/overdue flag appears → operator sees reminder preview → operator selects recipient and clicks **Send selected reminders** (demo mail adapter / `.eml` if not configured) → run and reminder history are visible. Operator also completes a routine inspection and raises an action.

## Delivery evidence

Deliver the running application, code, SQLite schema/migrations, seed script, README, key tests and short known-limitations note. Focus on real user journeys, not architecture theatre. If additional frameworks or services seem helpful, **do not add them** unless they solve a demonstrable MVP need.