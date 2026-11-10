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
  name?: string;
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
    ensureRoutineChecklists(db, t, now);
  })();
}

/** The five original question groups, in source order, as editable checklist templates. */
export const ROUTINE_GROUPS: { code: string; group: string; name: string }[] = [
  { code: 'RPI-FIRE', group: 'Fire Safety', name: 'Routine — Fire Safety' },
  { code: 'RPI-SEC', group: 'Security', name: 'Routine — Security' },
  { code: 'RPI-UTIL', group: 'Gas, Electrical & Utilities', name: 'Routine — Gas, Electrical & Utilities' },
  { code: 'RPI-HWB', group: 'Health & Wellbeing Risks', name: 'Routine — Health & Wellbeing Risks' },
  { code: 'RPI-GEN', group: 'General Property Safety', name: 'Routine — General Property Safety' },
];

/**
 * Routine visual checks get their own configurable Compliance Type (no certificate requirement) and five
 * checklist templates holding the original 30 questions verbatim. They are NOT mapped onto PAT/FRA/Gas/
 * Legionella/EICR. Idempotent: existing templates (and any operator edits) are never overwritten.
 */
function ensureRoutineChecklists(db: DB, t: TemplateFile, now: string) {
  db.prepare(
    `INSERT OR IGNORE INTO compliance_types (code, name, suggested_interval_months, warning_days, evidence_required, active, notes, created_at, updated_at)
     VALUES ('RPI', 'Routine Property Inspection (visual)', 1, 7, 0, 1, ?, ?, ?)`,
  ).run('Routine visual walk-round checks. Not statutory certificates; no paperwork required by default. Interval is a placeholder.', now, now);
  const typeId = (db.prepare("SELECT id FROM compliance_types WHERE code = 'RPI'").get() as { id: number }).id;
  const insT = db.prepare(`INSERT OR IGNORE INTO checklist_templates (code, name, compliance_type_id, description, version, active, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`);
  const insI = db.prepare(`INSERT OR IGNORE INTO checklist_items (template_id, code, section, question, sort_order, mandatory, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`);
  for (const g of ROUTINE_GROUPS) {
    const fresh = insT.run(g.code, g.name, typeId, `${g.group} questions from ${t.template_code} (${t.name ?? 'routine inspection'}), imported verbatim.`,
      `${t.template_code} ${t.version}`, now, now).changes > 0;
    if (!fresh) continue;
    const tid = (db.prepare('SELECT id FROM checklist_templates WHERE code = ?').get(g.code) as { id: number }).id;
    t.questions.filter((q) => q.group === g.group).forEach((q, i) => insI.run(tid, q.code, q.group, q.question, i + 1, now, now));
  }
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
      `INSERT INTO actions (ref, activity_id, visit_id, site_id, title, priority, owner_user_id, due_on, state, notes, created_at, updated_at)
       VALUES ('PH-X' || printf('%03d', (SELECT COUNT(*) + 1 FROM actions)), ?, ?, ?, ?, 'Critical', ?, ?, 'Open', 'Fictional demo remedial', ?, ?)`,
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
        const target = offset === null ? null : addDays(today, offset);
        const last = target && t.m ? addMonths(target, -t.m) : null;
        // Next due is always derived from last done + interval (same arithmetic as the app).
        const due = last && t.m ? addMonths(last, t.m) : target;
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
          docLink.run(did, 'activity', aid, 'certificate', now);
          if (tcode === 'FRA') docLink.run(did, 'site', siteId, 'evidence', now); // same file, second context
          // The historical visit whose certificate this is; it set the current schedule.
          if (last) {
            const verified = docKind === 'verified';
            const vid = seedVisit(db, {
              activityId: aid, siteId, roomId: level === 'room' ? gasRoom.id : null, performed: last, inspector: users[i <= 5 ? 1 : 2],
              provider: tcode === 'GAS' ? 'Demo Gas Engineer Ltd (fictional)' : '', nextDue: due!, now,
              status: s.critical ? 'complete_remedials' : verified ? 'closed' : 'awaiting_evidence', outcome: s.critical ? 'complete_remedials' : 'complete',
            });
            docLink.run(did, 'inspection', vid, 'certificate', now);
            if (s.critical) action.run(aid, vid, siteId, s.critical, owner, addDays(today, 7), now, now);
          }
        }
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

    seedRoutine(db, today, now, users, actNo);
    setSetting(db, 'recalculation_pending', 'false');
  })();
  return true;
}

interface SeedVisit {
  activityId: number; siteId: number | null; roomId: number | null; performed: string; inspector: number; provider: string;
  nextDue: string; now: string; status: string; outcome: string | null; checklistTemplateId?: number | null;
}

/** Inserts a completed (or in-progress) visit with a checklist snapshot and makes it the activity's schedule source. */
function seedVisit(db: DB, v: SeedVisit): number {
  let snap = '[]';
  let tpl: { id: number; version: number; name: string } | undefined;
  if (v.checklistTemplateId) {
    tpl = db.prepare('SELECT id, version, name FROM checklist_templates WHERE id = ?').get(v.checklistTemplateId) as { id: number; version: number; name: string };
    snap = JSON.stringify(db.prepare('SELECT code, section, question, sort_order, mandatory FROM checklist_items WHERE template_id = ? AND active = 1 ORDER BY sort_order')
      .all(tpl.id));
  }
  const n = (db.prepare('SELECT COUNT(*) AS n FROM visits').get() as { n: number }).n + 1;
  const completed = v.status !== 'in_progress';
  const at = `${v.performed}T15:00:00.000Z`;
  const id = Number(db.prepare(
    `INSERT INTO visits (ref, activity_id, site_id, room_id, performed_on, inspector_user_id, provider_name, notes, checklist_template_id, checklist_version,
       checklist_name, checklist_snapshot, status, outcome, completed_at, closed_at, next_due_set, schedule_applied, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Fictional demo visit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`PH-V${String(n).padStart(3, '0')}`, v.activityId, v.siteId, v.roomId, v.performed, v.inspector, v.provider, tpl?.id ?? null, tpl?.version ?? null,
    tpl?.name ?? '', snap, v.status, completed ? v.outcome : null, completed ? at : null, v.status === 'closed' ? at : null, completed ? v.nextDue : null,
    completed ? 1 : 0, v.now, v.now).lastInsertRowid);
  db.prepare('INSERT INTO visit_events (visit_id, at, event, detail) VALUES (?, ?, ?, ?)').run(id, v.now, 'seeded', 'Fictional demo record');
  if (completed) db.prepare('UPDATE compliance_activities SET schedule_visit_id = ? WHERE id = ?').run(id, v.activityId);
  return id;
}

/**
 * Routine (visual) activities: every site gets Fire Safety (monthly) and General Property Safety (quarterly)
 * on separate schedules; PH-S001/PH-S002 also get Security, Utilities and Health & Wellbeing. Demo visits show
 * each lifecycle state: closed, complete with remedials, and in progress.
 */
function seedRoutine(db: DB, today: string, now: string, users: number[], startNo: number) {
  const rpi = db.prepare("SELECT id FROM compliance_types WHERE code = 'RPI'").get() as { id: number } | undefined;
  if (!rpi) return;
  const tpl = (code: string) => (db.prepare('SELECT id FROM checklist_templates WHERE code = ?').get(code) as { id: number }).id;
  const sites = db.prepare('SELECT id, code, area_id FROM sites ORDER BY code').all() as { id: number; code: string; area_id: number }[];
  const ins = db.prepare(
    `INSERT INTO compliance_activities (ref, type_id, name, location_level, site_id, owner_user_id, last_done_on, next_due_on, interval_months, applicability,
       checklist_template_id, notes, created_at, updated_at) VALUES (?, ?, ?, 'site', ?, ?, ?, ?, ?, 'required', ?, '', ?, ?)`,
  );
  let n = startNo;
  const made: Record<string, number> = {};
  sites.forEach((s, i) => {
    const plan: [string, string, number, number][] = [['RPI-FIRE', 'Routine Fire Safety', 1, 10 + (i % 3) * 5], ['RPI-GEN', 'Routine General Property Safety', 3, 40 + i * 4]];
    if (i < 2) plan.push(['RPI-SEC', 'Routine Security', 3, 50], ['RPI-UTIL', 'Routine Gas, Electrical & Utilities', 3, 60], ['RPI-HWB', 'Routine Health & Wellbeing', 3, 70]);
    for (const [code, name, months, ago] of plan) {
      const last = addDays(today, -ago);
      const ref = `PH-C${String(++n).padStart(3, '0')}`;
      const id = Number(ins.run(ref, rpi.id, `${name} - ${s.code}`, s.id, users[s.area_id === sites[0].area_id ? 1 : 2], last, addMonths(last, months), months, tpl(code), now, now).lastInsertRowid);
      made[`${s.code}/${code}`] = id;
    }
  });
  const ans = db.prepare('INSERT INTO visit_answers (visit_id, item_code, response, notes) VALUES (?, ?, ?, ?)');
  const itemsOf = (code: string) => db.prepare('SELECT code FROM checklist_items WHERE template_id = ? ORDER BY sort_order').all(tpl(code)) as { code: string }[];

  // PH-S001 Fire Safety: closed visit, all Pass.
  const a1 = made['PH-S001/RPI-FIRE'];
  const r1 = db.prepare('SELECT last_done_on, next_due_on FROM compliance_activities WHERE id = ?').get(a1) as { last_done_on: string; next_due_on: string };
  const v1 = seedVisit(db, { activityId: a1, siteId: sites[0].id, roomId: null, performed: r1.last_done_on, inspector: users[1], provider: '', nextDue: r1.next_due_on, now,
    status: 'closed', outcome: 'complete', checklistTemplateId: tpl('RPI-FIRE') });
  for (const q of itemsOf('RPI-FIRE')) ans.run(v1, q.code, 'Pass', '');

  // PH-S001 General Property Safety: complete with one remedial In progress (trip hazard).
  const a2 = made['PH-S001/RPI-GEN'];
  const r2 = db.prepare('SELECT last_done_on, next_due_on FROM compliance_activities WHERE id = ?').get(a2) as { last_done_on: string; next_due_on: string };
  const v2 = seedVisit(db, { activityId: a2, siteId: sites[0].id, roomId: null, performed: r2.last_done_on, inspector: users[1], provider: '', nextDue: r2.next_due_on, now,
    status: 'complete_remedials', outcome: 'complete_remedials', checklistTemplateId: tpl('RPI-GEN') });
  itemsOf('RPI-GEN').forEach((q, i) => ans.run(v2, q.code, i === 0 ? 'Issue' : 'Pass', i === 0 ? 'Loose stair carpet on first landing (demo)' : ''));
  db.prepare(
    `INSERT INTO actions (ref, activity_id, visit_id, question_code, site_id, title, description, priority, owner_user_id, due_on, state, notes, created_at, updated_at)
     VALUES ('PH-X' || printf('%03d', (SELECT COUNT(*) + 1 FROM actions)), ?, ?, ?, ?, ?, ?, 'High', ?, ?, 'In progress', '', ?, ?)`,
  ).run(a2, v2, itemsOf('RPI-GEN')[0].code, sites[0].id, 'Refix loose stair carpet (demo)', 'Raised from routine visit.', users[1], addDays(today, 7), now, now);

  // PH-S002 Fire Safety: visit in progress (3 of 8 answered).
  const a3 = made['PH-S002/RPI-FIRE'];
  const v3 = seedVisit(db, { activityId: a3, siteId: sites[1].id, roomId: null, performed: today, inspector: users[1], provider: '', nextDue: today, now,
    status: 'in_progress', outcome: null, checklistTemplateId: tpl('RPI-FIRE') });
  itemsOf('RPI-FIRE').slice(0, 3).forEach((q) => ans.run(v3, q.code, 'Pass', ''));
}
