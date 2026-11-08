// Ordered SQLite migrations (v0.3 Area > Site > Room > Equipment model).
// Applied once each, tracked in schema_migrations. The obsolete flat
// properties / property_checks schema from the interrupted v0.2 run is NOT kept.
export interface Migration {
  version: number;
  name: string;
  sql: string;
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
];
