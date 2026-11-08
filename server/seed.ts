// Reference data (always) + fictional demo data (only into an empty database).
// ALL names, codes and emails are fictional. No real locations, addresses or residents.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { DEFAULT_SETTINGS, setSetting } from './db.js';
import { addDays, addMonths } from './dates.js';

export const TEMPLATE_PATH = fileURLToPath(new URL('../data/inspection_template_seed.json', import.meta.url));

interface TemplateFile {
  template_code: string;
  version: string;
  question_count: number;
  questions: { code: string; group: string; question: string; sort_order: number; access_tier: string; source_sheet: string; source_row: number }[];
}

export function loadTemplate(): TemplateFile {
  const t = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')) as TemplateFile;
  if (t.questions.length !== t.question_count || t.question_count !== 30) {
    throw new Error(`Inspection template integrity error: expected 30 questions, found ${t.questions.length}`);
  }
  return t;
}

/** Idempotent: imports the 30 source checklist questions verbatim, default settings and the 5 seeded types. */
export function ensureReferenceData(db: DB): void {
  const t = loadTemplate();
  const now = new Date().toISOString();
  const insQ = db.prepare(
    `INSERT OR IGNORE INTO checklist_questions (code, group_name, question, sort_order, access_tier, source_sheet, source_row, template_code, template_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insType = db.prepare(
    `INSERT OR IGNORE INTO compliance_types (code, name, suggested_interval_months, warning_days, evidence_required, active, notes, created_at, updated_at)
     VALUES (?, ?, ?, 30, 1, 1, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const q of t.questions) insQ.run(q.code, q.group, q.question, q.sort_order, q.access_tier, q.source_sheet, q.source_row, t.template_code, t.version);
    const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
    // Working list only — intervals are configurable and must be confirmed by the Compliance Officer.
    const note = 'Default interval is a placeholder; confirm with the Compliance Officer.';
    insType.run('PAT', 'PAT Testing', 12, note, now, now);
    insType.run('FRA', 'Fire Risk Assessment (FRA)', 12, note, now, now);
    insType.run('GAS', 'Gas Safety', 12, note, now, now);
    insType.run('LEG', 'Legionella', 24, note, now, now);
    insType.run('EICR', 'Electrical Installation Condition Report (EICR)', 60, note, now, now);
  })();
}

/** A tiny valid one-page PDF so seeded "certificates" open in a browser. */
export function dummyPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, '');
  const stream = `BT /F1 14 Tf 60 760 Td (${safe}) Tj 0 -24 Td (FICTIONAL DEMO DOCUMENT - NOT A REAL CERTIFICATE) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const code = (prefix: string, n: number) => `${prefix}${String(n).padStart(3, '0')}`;

type Scenario = {
  applicability?: 'required' | 'not_applicable' | 'unknown';
  naReason?: string;
  dueOffset?: number | null; // null = no dates recorded
  doc?: 'verified' | 'unverified' | 'none';
  critical?: string;
};

/** Seeds 2 Areas / 10 Sites / Rooms / Equipment / Activities if the database has no Areas. Returns true if seeded. */
export function seedDemo(db: DB, uploadsDir: string, today: string): boolean {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM areas').get() as { n: number }).n;
  if (count > 0) return false;
  fs.mkdirSync(uploadsDir, { recursive: true });
  const now = new Date().toISOString();

  db.transaction(() => {
    const user = db.prepare('INSERT INTO users (name, email, team, role_label, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)');
    const users = [
      ['Demo Operator', 'operator@example.test', 'Compliance', 'Operator'],
      ['Team Leader North (fictional)', 'tl.north@example.test', 'North team', 'Team Leader'],
      ['Team Leader South (fictional)', 'tl.south@example.test', 'South team', 'Team Leader'],
      ['Maintenance Contact (no email)', '', 'Maintenance', 'Contact'],
    ].map((u) => Number(user.run(...u, now, now).lastInsertRowid));

    const area = db.prepare('INSERT INTO areas (code, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const areaIds = [
      Number(area.run('PH-A001', 'Area North (demo)', 'Fictional demo area', now, now).lastInsertRowid),
      Number(area.run('PH-A002', 'Area South (demo)', 'Fictional demo area', now, now).lastInsertRowid),
    ];
    const site = db.prepare('INSERT INTO sites (area_id, code, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const room = db.prepare('INSERT INTO rooms (site_id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const equip = db.prepare(
      'INSERT INTO equipment (room_id, asset_code, description, category, serial_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const types = Object.fromEntries(
      (db.prepare('SELECT id, code, suggested_interval_months AS m FROM compliance_types').all() as { id: number; code: string; m: number | null }[]).map(
        (t) => [t.code, t],
      ),
    );
    const act = db.prepare(
      `INSERT INTO compliance_activities (ref, type_id, name, location_level, area_id, site_id, room_id, owner_user_id,
         last_done_on, next_due_on, applicability, na_reason, notes, created_at, updated_at)
       VALUES (@ref, @type_id, @name, @level, @area_id, @site_id, @room_id, @owner, @last, @due, @app, @na, '', @now, @now)`,
    );
    const link = db.prepare('INSERT INTO activity_equipment (activity_id, equipment_id, created_at) VALUES (?, ?, ?)');
    const doc = db.prepare(
      `INSERT INTO documents (display_name, storage_key, original_filename, mime_type, size_bytes, sha256, uploaded_at, issued_on, valid_until,
         verified_by_operator, verified_at, notes) VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, ?, 'Fictional demo document')`,
    );
    const docLink = db.prepare('INSERT INTO document_links (document_id, entity_kind, entity_id, link_role, created_at) VALUES (?, ?, ?, ?, ?)');
    const action = db.prepare(
      `INSERT INTO actions (ref, activity_id, site_id, title, priority, owner_user_id, due_on, state, notes, created_at, updated_at)
       VALUES ('PH-X' || printf('%03d', (SELECT COUNT(*) + 1 FROM actions)), ?, ?, ?, 'Critical', ?, ?, 'Open', 'Fictional demo action', ?, ?)`,
    );

    // Scenario overrides keyed "siteNo/TYPE" (siteNo 1..10) to give a realistic RAG spread.
    const scenarios: Record<string, Scenario> = {
      '1/GAS': { dueOffset: 200 },
      '2/GAS': { dueOffset: 10 },
      '2/PAT': { dueOffset: -1 },
      '3/GAS': { dueOffset: -5 },
      '4/FRA': { dueOffset: 0 },
      '5/PAT': { applicability: 'not_applicable', naReason: 'No portable appliances supplied (demo)', dueOffset: null, doc: 'none' },
      '6/LEG': { applicability: 'unknown', dueOffset: null, doc: 'none' },
      '7/EICR': { dueOffset: null, doc: 'none' },
      '8/GAS': { dueOffset: 150, doc: 'unverified' },
      '9/FRA': { dueOffset: 120, critical: 'Fire door does not self-close (demo)' },
      '10/GAS': { dueOffset: 25 },
    };
    const roomPlan = [
      ['Kitchen', [['Kettle', 'Portable appliance'], ['Microwave', 'Portable appliance'], ['Gas hob', 'Gas appliance']]],
      ['Office', [['Desk lamp', 'Portable appliance'], ['Printer', 'Portable appliance']]],
      ['Plant Room', [['Gas boiler', 'Gas appliance'], ['Hot water cylinder', 'Water system'], ['Consumer unit', 'Fixed electrical']]],
      ['Lounge', [['Television', 'Portable appliance']]],
    ] as const;

    let roomNo = 0, eqNo = 0, actNo = 0;
    const writeDoc = (label: string, issued: string | null, validUntil: string | null, verified: boolean) => {
      const key = `${crypto.randomUUID()}.pdf`;
      const bytes = dummyPdf(`${label} - demo certificate`);
      fs.writeFileSync(path.join(uploadsDir, key), bytes);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      return Number(
        doc.run(`${label} certificate (demo)`, key, `${label.replace(/[^A-Za-z0-9-]+/g, '_')}_demo.pdf`, bytes.length, sha, now, issued, validUntil,
          verified ? 1 : 0, verified ? now : null).lastInsertRowid,
      );
    };

    for (let i = 1; i <= 10; i++) {
      const areaId = areaIds[i <= 5 ? 0 : 1];
      const owner = users[i <= 5 ? 1 : 2];
      const siteCode = code('PH-S', i);
      const siteId = Number(site.run(areaId, siteCode, `Demo House ${String(i).padStart(2, '0')}`, 'Fictional demo site', now, now).lastInsertRowid);
      const rooms: Record<string, { id: number; equipment: { id: number; category: string }[] }> = {};
      // Sites get 2-4 rooms; site 10 has no rooms yet (sites may exist without rooms).
      const nRooms = i === 10 ? 0 : 2 + (i % 3);
      for (const [rName, kit] of roomPlan.slice(0, nRooms)) {
        const rid = Number(room.run(siteId, code('PH-R', ++roomNo), rName, now, now).lastInsertRowid);
        rooms[rName] = { id: rid, equipment: [] };
        for (const [desc, cat] of kit) {
          const eid = Number(equip.run(rid, code('PH-E', ++eqNo), `${desc} (demo)`, cat, `SN-DEMO-${1000 + eqNo}`, now, now).lastInsertRowid);
          rooms[rName].equipment.push({ id: eid, category: cat });
        }
      }

      for (const [j, tcode] of ['FRA', 'GAS', 'PAT', 'LEG', 'EICR'].entries()) {
        const s = scenarios[`${i}/${tcode}`] ?? {};
        const t = types[tcode];
        // Gas is room-level (where the appliance is); everything else site-level.
        const gasRoom = rooms['Plant Room'] ?? rooms['Kitchen'];
        if (tcode === 'GAS' && !gasRoom) continue;
        const level = tcode === 'GAS' ? 'room' : 'site';
        const offset = s.dueOffset === undefined ? 60 + ((i * 37 + j * 53) % 300) : s.dueOffset;
        const due = offset === null ? null : addDays(today, offset);
        const last = due && t.m ? addMonths(due, -t.m) : null;
        const ref = code('PH-C', ++actNo);
        const aid = Number(
          act.run({
            ref, type_id: t.id, name: `${tcode} - ${siteCode}`, level, area_id: null,
            site_id: level === 'site' ? siteId : null, room_id: level === 'room' ? gasRoom.id : null,
            owner: i === 7 ? users[3] : owner, last, due, app: s.applicability ?? 'required', na: s.naReason ?? '', now,
          }).lastInsertRowid,
        );
        // Equipment links: PAT covers portable kit across the site's rooms; GAS covers gas appliances in its room.
        const all = Object.values(rooms).flatMap((r) => r.equipment);
        const linked =
          tcode === 'PAT' && s.applicability !== 'not_applicable' ? all.filter((e) => e.category === 'Portable appliance')
            : tcode === 'GAS' ? gasRoom.equipment.filter((e) => e.category === 'Gas appliance')
              : tcode === 'LEG' ? all.filter((e) => e.category === 'Water system') : [];
        for (const e of linked) link.run(aid, e.id, now);

        const docKind = s.doc ?? 'verified';
        if (docKind !== 'none' && due) {
          const did = writeDoc(`${ref} ${tcode} ${siteCode}`, last, due, docKind === 'verified');
          docLink.run(did, 'activity', aid, 'evidence', now);
          if (tcode === 'FRA') docLink.run(did, 'site', siteId, 'evidence', now); // same file, second context
        }
        if (s.critical) action.run(aid, siteId, s.critical, owner, addDays(today, 7), now, now);
      }
    }

    // One Area-level activity to demonstrate the Area scope.
    const areaDue = addDays(today, 45);
    const areaActId = Number(act.run({
      ref: code('PH-C', ++actNo), type_id: types.LEG.id, name: 'Area water hygiene review', level: 'area', area_id: areaIds[0],
      site_id: null, room_id: null, owner: users[1], last: addMonths(areaDue, -24), due: areaDue, app: 'required', na: '', now,
    }).lastInsertRowid);
    const did = writeDoc('PH-A001 water hygiene policy', addMonths(areaDue, -24), null, true);
    docLink.run(did, 'activity', areaActId, 'evidence', now);
    docLink.run(did, 'area', areaIds[0], 'reference', now);

    seedInspections(db, today, now, users);
    setSetting(db, 'recalculation_pending', 'false');
  })();
  return true;
}

/** Two fictional routine inspections: one completed (with an Issue and its remedial action), one draft in progress. */
function seedInspections(db: DB, today: string, now: string, users: number[]) {
  const qs = db.prepare('SELECT code FROM checklist_questions ORDER BY sort_order').all() as { code: string }[];
  if (!qs.length) return;
  const tmpl = db.prepare('SELECT template_code, template_version FROM checklist_questions LIMIT 1').get() as { template_code: string; template_version: string };
  const site = (code: string) => (db.prepare('SELECT id FROM sites WHERE code = ?').get(code) as { id: number }).id;
  const run = db.prepare(
    `INSERT INTO inspection_runs (ref, site_id, room_id, inspected_on, state, completed_at, notes, inspector_user_id, inspector_name, template_code, template_version, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
  );
  const ans = db.prepare('INSERT INTO inspection_answers (run_id, question_code, response, notes) VALUES (?, ?, ?, ?)');

  const done = Number(run.run('PH-I001', site('PH-S001'), addDays(today, -14), 'complete', now, 'Fictional demo inspection', users[1],
    tmpl.template_code, tmpl.template_version, now, now).lastInsertRowid);
  let issueAnswer = 0;
  qs.forEach((q, i) => {
    const response = i === 4 ? 'Issue' : i === 11 ? 'Not applicable' : 'Pass';
    const id = Number(ans.run(done, q.code, response, i === 4 ? 'Wedge found holding a door open (demo)' : '').lastInsertRowid);
    if (i === 4) issueAnswer = id;
  });
  db.prepare(
    `INSERT INTO actions (ref, activity_id, inspection_answer_id, inspection_run_id, site_id, title, description, priority, owner_user_id, due_on, state, notes, created_at, updated_at)
     VALUES ('PH-X' || printf('%03d', (SELECT COUNT(*) + 1 FROM actions)), NULL, ?, ?, ?, ?, ?, 'High', ?, ?, 'In progress', '', ?, ?)`,
  ).run(issueAnswer, done, site('PH-S001'), 'Remove door wedge and brief staff (demo)', 'Raised from routine inspection PH-I001.', users[1], addDays(today, 7), now, now);

  const draft = Number(run.run('PH-I002', site('PH-S002'), today, 'draft', null, 'Fictional draft inspection', users[1],
    tmpl.template_code, tmpl.template_version, now, now).lastInsertRowid);
  qs.slice(0, 12).forEach((q) => ans.run(draft, q.code, 'Pass', ''));
}
