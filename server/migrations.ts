// Ordered SQLite migrations (v0.3 Area > Site > Room > Equipment model).
// Applied once each, tracked in schema_migrations. The obsolete flat
// properties / property_checks schema from the interrupted v0.2 run is NOT kept.
import type Database from 'better-sqlite3';
import { derivedNextDue } from './schedule.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Optional data step run after `sql`, inside the same transaction. */
  up?: (db: Database.Database) => void;
}

const LEVEL_CHECK = `CHECK (
    (location_level = 'area' AND area_id IS NOT NULL AND site_id IS NULL AND room_id IS NULL) OR
    (location_level = 'site' AND site_id IS NOT NULL AND area_id IS NULL AND room_id IS NULL) OR
    (location_level = 'room' AND room_id IS NOT NULL AND area_id IS NULL AND site_id IS NULL)
  )`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'v0.3 hierarchy, activities, document library, recalculation, reminders',
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  role_label TEXT NOT NULL DEFAULT 'Contact' CHECK (role_label IN ('Operator','Team Leader','Contact')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE areas (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sites (
  id INTEGER PRIMARY KEY,
  area_id INTEGER NOT NULL REFERENCES areas(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sites_area ON sites(area_id);

CREATE TABLE rooms (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rooms_site ON rooms(site_id);

CREATE TABLE equipment (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  asset_code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  category TEXT NOT NULL DEFAULT '',
  serial_no TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_equipment_room ON equipment(room_id);

CREATE TABLE compliance_types (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  suggested_interval_months INTEGER CHECK (suggested_interval_months IS NULL OR suggested_interval_months > 0),
  warning_days INTEGER NOT NULL DEFAULT 30 CHECK (warning_days >= 0),
  evidence_required INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE compliance_activities (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  type_id INTEGER NOT NULL REFERENCES compliance_types(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT '',
  location_level TEXT NOT NULL CHECK (location_level IN ('area','site','room')),
  area_id INTEGER REFERENCES areas(id) ON DELETE RESTRICT,
  site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT,
  room_id INTEGER REFERENCES rooms(id) ON DELETE RESTRICT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_done_on TEXT,
  next_due_on TEXT,
  expires_on TEXT,
  interval_months INTEGER CHECK (interval_months IS NULL OR interval_months > 0),
  applicability TEXT NOT NULL DEFAULT 'required' CHECK (applicability IN ('required','not_applicable','unknown')),
  na_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ${LEVEL_CHECK}
);
CREATE INDEX idx_act_type ON compliance_activities(type_id);
CREATE INDEX idx_act_area ON compliance_activities(area_id);
CREATE INDEX idx_act_site ON compliance_activities(site_id);
CREATE INDEX idx_act_room ON compliance_activities(room_id);
CREATE INDEX idx_act_due ON compliance_activities(next_due_on);

CREATE TABLE activity_equipment (
  activity_id INTEGER NOT NULL REFERENCES compliance_activities(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (activity_id, equipment_id)
);
CREATE INDEX idx_ae_equipment ON activity_equipment(equipment_id);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  issued_on TEXT,
  valid_until TEXT,
  verified_by_operator INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  supersedes_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL
);
CREATE INDEX idx_documents_sha ON documents(sha256);

CREATE TABLE document_links (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('area','site','room','equipment','activity','inspection','action')),
  entity_id INTEGER NOT NULL,
  link_role TEXT NOT NULL DEFAULT 'evidence',
  created_at TEXT NOT NULL,
  UNIQUE (document_id, entity_kind, entity_id, link_role)
);
CREATE INDEX idx_doclinks_entity ON document_links(entity_kind, entity_id);

CREATE TABLE checklist_questions (
  code TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  question TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  access_tier TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  template_code TEXT NOT NULL,
  template_version TEXT NOT NULL
);

CREATE TABLE inspection_runs (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  room_id INTEGER REFERENCES rooms(id) ON DELETE RESTRICT,
  inspected_on TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','complete')),
  completed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE inspection_answers (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES inspection_runs(id) ON DELETE CASCADE,
  question_code TEXT NOT NULL REFERENCES checklist_questions(code),
  response TEXT NOT NULL DEFAULT 'Not checked' CHECK (response IN ('Pass','Issue','Not applicable','Not checked')),
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (run_id, question_code)
);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER REFERENCES compliance_activities(id) ON DELETE SET NULL,
  inspection_answer_id INTEGER REFERENCES inspection_answers(id) ON DELETE SET NULL,
  site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low','Medium','High','Critical')),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_on TEXT,
  state TEXT NOT NULL DEFAULT 'Open' CHECK (state IN ('Open','In progress','Done')),
  closed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_actions_activity ON actions(activity_id);

CREATE TABLE recalculation_runs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  totals_json TEXT NOT NULL,
  config_json TEXT NOT NULL
);

CREATE TABLE activity_status_snapshots (
  run_id INTEGER NOT NULL REFERENCES recalculation_runs(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES compliance_activities(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('green','amber','red','grey','na')),
  days_to_due INTEGER,
  due_on TEXT,
  reason TEXT NOT NULL,
  PRIMARY KEY (run_id, activity_id)
);
CREATE INDEX idx_snap_activity ON activity_status_snapshots(activity_id);

CREATE TABLE reminder_candidates (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES recalculation_runs(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES compliance_activities(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_name TEXT NOT NULL DEFAULT '',
  recipient_email TEXT NOT NULL DEFAULT '',
  threshold TEXT NOT NULL,
  due_on TEXT NOT NULL,
  days_to_due INTEGER NOT NULL,
  message_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  draft_text TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rc_run ON reminder_candidates(run_id);

CREATE TABLE email_log (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER REFERENCES reminder_candidates(id) ON DELETE SET NULL,
  message_key TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo_send','eml_export')),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent','exported','failed','skipped_duplicate')),
  resend INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  outbox_file TEXT NOT NULL DEFAULT ''
);
-- Duplicate guard: one first-time 'sent' per message key; repeats need explicit Resend.
CREATE UNIQUE INDEX ux_email_first_send ON email_log(message_key) WHERE outcome = 'sent' AND resend = 0;
`,
  },
  {
    version: 2,
    name: 'P1 routine inspections (inspector, refs) and remedial actions (description, room, source inspection, closure)',
    sql: `
ALTER TABLE inspection_runs ADD COLUMN ref TEXT;
ALTER TABLE inspection_runs ADD COLUMN inspector_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE inspection_runs ADD COLUMN inspector_name TEXT NOT NULL DEFAULT '';
ALTER TABLE inspection_runs ADD COLUMN template_code TEXT NOT NULL DEFAULT '';
ALTER TABLE inspection_runs ADD COLUMN template_version TEXT NOT NULL DEFAULT '';
ALTER TABLE inspection_runs ADD COLUMN updated_at TEXT;
UPDATE inspection_runs SET ref = 'PH-I' || printf('%03d', id), updated_at = created_at WHERE ref IS NULL;
CREATE UNIQUE INDEX ux_inspection_ref ON inspection_runs(ref);
CREATE INDEX idx_inspection_site ON inspection_runs(site_id);

ALTER TABLE actions ADD COLUMN ref TEXT;
ALTER TABLE actions ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE actions ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN inspection_run_id INTEGER REFERENCES inspection_runs(id) ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN closure_notes TEXT NOT NULL DEFAULT '';
UPDATE actions SET ref = 'PH-X' || printf('%03d', id) WHERE ref IS NULL;
CREATE UNIQUE INDEX ux_action_ref ON actions(ref);
CREATE INDEX idx_actions_site ON actions(site_id);
CREATE INDEX idx_actions_run ON actions(inspection_run_id);
`,
  },
  {
    version: 3,
    name: 'V2: checklist templates, visits (inspection occurrences) with lifecycle, remedials on visits, calculated next due, schedule log',
    sql: `
-- Checklist templates belong to a Compliance Type; items are editable; visits keep a frozen snapshot.
CREATE TABLE checklist_templates (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  compliance_type_id INTEGER NOT NULL REFERENCES compliance_types(id) ON DELETE RESTRICT,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE checklist_items (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL CHECK (length(trim(question)) > 0),
  sort_order INTEGER NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (template_id, code)
);
CREATE INDEX idx_items_template ON checklist_items(template_id, sort_order);

ALTER TABLE compliance_activities ADD COLUMN checklist_template_id INTEGER REFERENCES checklist_templates(id) ON DELETE SET NULL;
ALTER TABLE compliance_activities ADD COLUMN next_due_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE compliance_activities ADD COLUMN next_due_override_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE compliance_activities ADD COLUMN schedule_visit_id INTEGER;

-- An Inspection / Visit is one occurrence of work against a Compliance Activity.
CREATE TABLE visits (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  activity_id INTEGER REFERENCES compliance_activities(id) ON DELETE RESTRICT,
  site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT,
  room_id INTEGER REFERENCES rooms(id) ON DELETE RESTRICT,
  performed_on TEXT,
  inspector_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  provider_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  checklist_template_id INTEGER REFERENCES checklist_templates(id) ON DELETE SET NULL,
  checklist_version INTEGER,
  checklist_name TEXT NOT NULL DEFAULT '',
  checklist_snapshot TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','complete','complete_remedials','awaiting_evidence','closed')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('complete','complete_remedials')),
  completed_at TEXT,
  closed_at TEXT,
  next_due_override INTEGER NOT NULL DEFAULT 0,
  next_due_set TEXT,
  override_reason TEXT NOT NULL DEFAULT '',
  schedule_applied INTEGER NOT NULL DEFAULT 0,
  previous_last_done TEXT,
  previous_next_due TEXT,
  previous_override INTEGER NOT NULL DEFAULT 0,
  previous_override_reason TEXT NOT NULL DEFAULT '',
  previous_schedule_visit_id INTEGER,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_note TEXT NOT NULL DEFAULT '',
  legacy_inspection_run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_visits_activity ON visits(activity_id, performed_on);
CREATE INDEX idx_visits_site ON visits(site_id);
CREATE TABLE visit_answers (
  id INTEGER PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  item_code TEXT NOT NULL,
  response TEXT NOT NULL CHECK (response IN ('Pass','Issue','Not applicable','Not checked')),
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (visit_id, item_code)
);
CREATE TABLE visit_events (
  id INTEGER PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_visit_events ON visit_events(visit_id, at);

-- Remedials (table "actions") belong to a visit, optionally a checklist answer and equipment.
ALTER TABLE actions ADD COLUMN visit_id INTEGER REFERENCES visits(id) ON DELETE RESTRICT;
ALTER TABLE actions ADD COLUMN question_code TEXT;
ALTER TABLE actions ADD COLUMN equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_actions_visit ON actions(visit_id);

CREATE TABLE activity_schedule_log (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES compliance_activities(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('edit','visit','visit-reopen','type-interval','migration')),
  visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  old_last_done TEXT, new_last_done TEXT,
  old_next_due TEXT, new_next_due TEXT,
  old_override INTEGER NOT NULL DEFAULT 0, new_override INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_schedlog_activity ON activity_schedule_log(activity_id, changed_at);
`,
    up: (db) => {
      const now = new Date().toISOString();
      // 1. Schedules: a stored next-due equal to last done + interval becomes "calculated";
      //    a different stored date is preserved as an explicit, labelled override (never silently changed).
      const rows = db.prepare(
        `SELECT a.id, a.last_done_on, a.next_due_on, a.interval_months, t.suggested_interval_months AS type_interval
         FROM compliance_activities a JOIN compliance_types t ON t.id = a.type_id`,
      ).all() as { id: number; last_done_on: string | null; next_due_on: string | null; interval_months: number | null; type_interval: number | null }[];
      const setOverride = db.prepare("UPDATE compliance_activities SET next_due_override = 1, next_due_override_reason = 'Next-due date entered before v0.5 (kept as override; untick to calculate)' WHERE id = ?");
      const setDerived = db.prepare('UPDATE compliance_activities SET next_due_on = ? WHERE id = ?');
      for (const r of rows) {
        const derived = derivedNextDue(r.last_done_on, r.interval_months ?? r.type_interval);
        if (r.next_due_on && r.next_due_on !== derived) setOverride.run(r.id);
        else if (!r.next_due_on && derived) setDerived.run(derived, r.id);
      }

      // 2. Legacy routine 30-point inspections -> visits with the SAME id (so document links of kind
      //    'inspection' and remedial links stay valid). They are not linked to any Compliance Activity
      //    (that cannot be determined reliably) and are flagged for review. Old tables are left untouched.
      const legacyQs = db.prepare('SELECT code, group_name, question, sort_order, template_code, template_version FROM checklist_questions ORDER BY sort_order').all() as any[];
      const snapshot = JSON.stringify(legacyQs.map((q) => ({ code: q.code, section: q.group_name, question: q.question, sort_order: q.sort_order, mandatory: 1 })));
      const tv = legacyQs[0] ? `${legacyQs[0].template_code} ${legacyQs[0].template_version}` : '';
      const runs = db.prepare('SELECT * FROM inspection_runs ORDER BY id').all() as any[];
      const insVisit = db.prepare(
        `INSERT INTO visits (id, ref, activity_id, site_id, room_id, performed_on, inspector_user_id, provider_name, notes, checklist_name, checklist_snapshot,
           status, outcome, completed_at, needs_review, review_note, legacy_inspection_run_id, created_at, updated_at)
         VALUES (@id, @ref, NULL, @site_id, @room_id, @performed_on, @inspector_user_id, @provider_name, @notes, @checklist_name, @snapshot,
           @status, @outcome, @completed_at, 1, @review_note, @id, @created_at, @updated_at)`,
      );
      const openRemedials = db.prepare("SELECT COUNT(*) AS n FROM actions WHERE inspection_run_id = ? AND state <> 'Done'");
      const anyRemedials = db.prepare('SELECT COUNT(*) AS n FROM actions WHERE inspection_run_id = ?');
      const event = db.prepare('INSERT INTO visit_events (visit_id, at, event, detail) VALUES (?, ?, ?, ?)');
      for (const r of runs) {
        const done = r.state === 'complete';
        const open = (openRemedials.get(r.id) as { n: number }).n;
        const any = (anyRemedials.get(r.id) as { n: number }).n;
        insVisit.run({
          id: r.id, ref: r.ref ?? `PH-I${String(r.id).padStart(3, '0')}`, site_id: r.site_id, room_id: r.room_id, performed_on: r.inspected_on,
          inspector_user_id: r.inspector_user_id ?? null, provider_name: r.inspector_user_id ? '' : (r.inspector_name ?? ''), notes: r.notes ?? '',
          checklist_name: `Legacy 30-point routine inspection (${tv})`, snapshot,
          status: !done ? 'in_progress' : open ? 'complete_remedials' : 'complete', outcome: !done ? null : any ? 'complete_remedials' : 'complete',
          completed_at: done ? (r.completed_at ?? r.created_at) : null,
          review_note: 'Upgraded from a v0.3 site-wide 30-point inspection. Not linked to a Compliance Activity: link it to the matching routine activity if appropriate.',
          created_at: r.created_at, updated_at: r.updated_at ?? r.created_at,
        });
        event.run(r.id, now, 'migrated', 'Copied from legacy routine inspection record during upgrade (original kept)');
      }
      db.prepare(
        `INSERT INTO visit_answers (visit_id, item_code, response, notes)
         SELECT run_id, question_code, response, notes FROM inspection_answers WHERE run_id IN (SELECT id FROM visits)`,
      ).run();

      // 3. Remedials: attach to their visit and checklist question where known; standalone ones are flagged.
      db.prepare('UPDATE actions SET visit_id = inspection_run_id WHERE inspection_run_id IS NOT NULL AND inspection_run_id IN (SELECT id FROM visits)').run();
      db.prepare('UPDATE actions SET question_code = (SELECT question_code FROM inspection_answers ia WHERE ia.id = actions.inspection_answer_id) WHERE inspection_answer_id IS NOT NULL').run();
      db.prepare('UPDATE actions SET needs_review = 1 WHERE visit_id IS NULL').run();
    },
  },
];
