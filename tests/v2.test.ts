// V2 workflow: checklists (Admin), activities with independent schedules, Inspection / Visit lifecycle,
// remedials on visits, closure rules, evidence requirement, history snapshots, migration of older databases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, openDb, type DB } from '../server/db';
import { createApp } from '../server/app';
import { ensureReferenceData, seedDemo } from '../server/seed';
import { MIGRATIONS } from '../server/migrations';

const NOW = new Date('2026-11-09T10:00:00Z');
const TODAY = '2026-11-09';
let db: DB;
let api: ReturnType<typeof request>;

beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-v2-'));
  db = openDb(':memory:');
  ensureReferenceData(db);
  seedDemo(db, path.join(tmp, 'uploads'), TODAY);
  api = request(createApp({ db, uploadsDir: path.join(tmp, 'uploads'), outboxDir: path.join(tmp, 'outbox'), now: () => NOW })) as unknown as ReturnType<typeof request>;
});

const ok = (r: request.Response, code = 200) => {
  if (r.status !== code) throw new Error(`Expected ${code}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const acts = async () => ok(await api.get('/api/activities')) as any[];
const actBy = async (pred: (a: any) => boolean) => (await acts()).find(pred);
const pending = async () => ok(await api.get('/api/status')).pending as boolean;
const answerAll = async (visit: any, response = 'Pass', except: Record<string, string> = {}) =>
  ok(await api.put(`/api/visits/${visit.id}/answers`).send({ answers: visit.questions.map((q: any) => ({ item_code: q.code, response: except[q.code] ?? response })) }));

describe('Admin › Checklists', () => {
  it('imports the 30 original questions verbatim into five routine checklists (8/4/5/6/7) under a routine type', async () => {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/inspection_template_seed.json'), 'utf8'));
    const list = ok(await api.get('/api/checklists'));
    const routine = list.filter((c: any) => c.type_code === 'RPI');
    expect(routine.map((c: any) => [c.code, c.item_count])).toEqual([['RPI-FIRE', 8], ['RPI-GEN', 7], ['RPI-HWB', 6], ['RPI-SEC', 4], ['RPI-UTIL', 5]]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))).sort((a: any, b: any) => routine.findIndex((c: any) => c.code === a[0]) - routine.findIndex((c: any) => c.code === b[0])));
    const all: any[] = [];
    for (const c of routine) all.push(...ok(await api.get(`/api/checklists/${c.id}`)).items);
    const byCode = new Map(all.map((i) => [i.code, i]));
    for (const q of seed.questions) expect(byCode.get(q.code)).toMatchObject({ question: q.question, section: q.group, mandatory: 1 });
    expect(all).toHaveLength(30);
    const rpi = ok(await api.get('/api/types')).find((t: any) => t.code === 'RPI');
    expect(rpi.evidence_required).toBe(0); // no universal certificate requirement for routine visual checks
    for (const code of ['PAT', 'FRA', 'GAS', 'LEG', 'EICR']) expect(routine.some((c: any) => c.type_code === code)).toBe(false);
  });

  it('creates, edits, reorders, archives and duplicates a checklist; every change bumps the version', async () => {
    const gas = ok(await api.get('/api/types')).find((t: any) => t.code === 'GAS');
    let c = ok(await api.post('/api/checklists').send({ name: 'Gas safety visit (demo)', compliance_type_id: gas.id }), 201);
    expect(c).toMatchObject({ version: 1, item_count: 0, type_code: 'GAS' });
    c = ok(await api.post(`/api/checklists/${c.id}/items`).send({ question: 'Appliances tested', section: 'Gas' }), 201);
    c = ok(await api.post(`/api/checklists/${c.id}/items`).send({ question: 'CO alarm present', section: 'Gas', mandatory: false }), 201);
    c = ok(await api.post(`/api/checklists/${c.id}/items`).send({ question: 'Flue visually sound', section: 'Gas' }), 201);
    expect(c.version).toBe(4);
    expect(c.items.map((i: any) => [i.question, i.mandatory])).toEqual([['Appliances tested', 1], ['CO alarm present', 0], ['Flue visually sound', 1]]);
    const [a, b, d] = c.items.map((i: any) => i.id);
    c = ok(await api.post(`/api/checklists/${c.id}/reorder`).send({ item_ids: [d, a, b] }));
    expect(c.items.map((i: any) => i.question)).toEqual(['Flue visually sound', 'Appliances tested', 'CO alarm present']);
    c = ok(await api.put(`/api/checklist-items/${a}`).send({ question: 'All gas appliances tested', mandatory: true }));
    c = ok(await api.put(`/api/checklist-items/${b}`).send({ active: false }));
    expect(c.item_count).toBe(2);
    expect(c.version).toBe(7);
    const dup = ok(await api.post(`/api/checklists/${c.id}/duplicate`).send({ name: 'Gas safety visit (copy)' }), 201);
    expect(dup).toMatchObject({ version: 1, item_count: 2, compliance_type_id: gas.id });
    const arch = ok(await api.put(`/api/checklists/${dup.id}`).send({ active: false }));
    expect(arch.active).toBe(0);
    const gasLists = ok(await api.get('/api/checklists')).filter((x: any) => x.type_code === 'GAS');
    expect(gasLists.length).toBe(2); // multiple checklists under one type
  });

  it('an activity can only use a checklist of its own Compliance Type', async () => {
    const fire = ok(await api.get('/api/checklists')).find((c: any) => c.code === 'RPI-FIRE');
    const pat = await actBy((a) => a.ref === 'PH-C003');
    expect((await api.put(`/api/activities/${pat.id}`).send({ checklist_template_id: fire.id })).status).toBe(400);
  });
});

describe('Separate schedules and visits', () => {
  const ctx: Record<string, any> = {};

  it('routine checklist groups are separate activities with their own schedules', async () => {
    const s3 = (await acts()).filter((a) => a.site_code === 'PH-S003' && a.type_code === 'RPI');
    const fire = s3.find((a) => a.checklist_name === 'Routine — Fire Safety');
    const gen = s3.find((a) => a.checklist_name === 'Routine — General Property Safety');
    expect(fire.effective_interval).toBe(1);
    expect(gen.effective_interval).toBe(3);
    expect(fire.next_due_on).not.toBe(gen.next_due_on);
    ctx.fire = fire;
    ctx.gen = gen;
  });

  it('starts a visit from the activity with a snapshot of only that checklist (8 questions, not 30)', async () => {
    ok(await api.post('/api/recalculate'));
    ctx.fireBefore = (await actBy((a) => a.id === ctx.fire.id)).status;
    const v = ok(await api.post('/api/visits').send({ activity_id: ctx.fire.id, inspector_user_id: ctx.fire.owner_user_id }), 201);
    expect(v).toMatchObject({ status: 'in_progress', status_label: 'Scheduled / In Progress', question_count: 8, checklist_name: 'Routine — Fire Safety', activity_ref: ctx.fire.ref, site_code: 'PH-S003' });
    expect(v.ref).toMatch(/^PH-V\d{3}$/);
    expect(v.sections).toEqual(['Fire Safety']);
    expect((await api.post('/api/visits').send({ activity_id: ctx.fire.id })).status).toBe(409); // one open visit per activity
    ctx.v = v;
  });

  it('Inspection Complete without remedials: schedule updates, status unchanged until Recalculate, then manual Close', async () => {
    expect((await api.post(`/api/visits/${ctx.v.id}/complete`).send({ outcome: 'complete' })).status).toBe(400); // mandatory unanswered
    ctx.v = await answerAll(ctx.v);
    expect((await api.post(`/api/visits/${ctx.v.id}/complete`).send({ outcome: 'complete_remedials' })).status).toBe(400); // no remedials
    const done = ok(await api.post(`/api/visits/${ctx.v.id}/complete`).send({ outcome: 'complete' }));
    expect(done).toMatchObject({ status: 'complete', outcome: 'complete', closed_at: null, next_due_set: '2026-12-09', blockers: [] });
    expect(done.completed_at).toBeTruthy();
    const a = await actBy((x) => x.id === ctx.fire.id);
    expect(a).toMatchObject({ last_done_on: TODAY, next_due_on: '2026-12-09', schedule_visit_id: ctx.v.id, status: ctx.fireBefore });
    expect(await pending()).toBe(true);
    ok(await api.post('/api/recalculate'));
    let b = await actBy((x) => x.id === ctx.fire.id);
    expect(b.status).toBe('amber'); // work done but inspection not closed: not yet compliant
    expect(b.status_reason).toBe(`Inspection ${ctx.v.ref} complete, not yet closed`);
    const closed = ok(await api.post(`/api/visits/${ctx.v.id}/close`));
    expect(closed).toMatchObject({ status: 'closed', status_label: 'Closed' });
    expect(closed.closed_at > closed.completed_at || closed.closed_at === closed.completed_at).toBe(true);
    expect(await pending()).toBe(true);
    b = await actBy((x) => x.id === ctx.fire.id);
    expect(b.status).toBe('amber'); // still the old snapshot
    ok(await api.post('/api/recalculate'));
    b = await actBy((x) => x.id === ctx.fire.id);
    expect(b.status).toBe('green');
    expect(b.status_reason).toMatch(new RegExp(`^Compliant / verified: ${ctx.v.ref} closed`));
    expect(b.last_closed_at).toBe(closed.closed_at);
  });

  it('Inspection Complete with Remedials: Close blocked; Critical turns activity red at next Recalculate; last remedial auto-closes (no evidence required)', async () => {
    let v = ok(await api.post('/api/visits').send({ activity_id: ctx.gen.id, provider_name: 'Demo inspector' }), 201);
    v = await answerAll(v, 'Pass', { [v.questions[2].code]: 'Issue' });
    const q = v.questions[2].code;
    expect((await api.post('/api/actions').send({ visit_id: v.id, question_code: v.questions[0].code, title: 'x' })).status).toBe(400); // answer is Pass
    const other = await actBy((a) => a.ref === 'PH-C001');
    expect((await api.post('/api/actions').send({ visit_id: v.id, activity_id: other.id, title: 'x' })).status).toBe(400); // cannot point at another activity
    const otherSiteEq = ok(await api.get('/api/equipment')).find((e: any) => e.site_code !== 'PH-S003');
    expect((await api.post('/api/actions').send({ visit_id: v.id, equipment_id: otherSiteEq.id, title: 'x' })).status).toBe(400);
    const r1 = ok(await api.post('/api/actions').send({ visit_id: v.id, question_code: q, title: 'Secure loose handrail (demo)', priority: 'Critical', due_on: '2026-11-12' }), 201);
    const r2 = ok(await api.post('/api/actions').send({ visit_id: v.id, title: 'Replace missing bulb (demo)', priority: 'Low' }), 201);
    expect(r1).toMatchObject({ visit_ref: v.ref, activity_ref: ctx.gen.ref, question_code: q, site_code: 'PH-S003', visit_status_label: 'Scheduled / In Progress' });
    expect((await api.post(`/api/visits/${v.id}/complete`).send({ outcome: 'complete' })).status).toBe(400); // open remedials
    v = ok(await api.post(`/api/visits/${v.id}/complete`).send({ outcome: 'complete_remedials' }));
    expect(v).toMatchObject({ status: 'complete_remedials', outcome: 'complete_remedials' });
    const close = await api.post(`/api/visits/${v.id}/close`);
    expect(close.status).toBe(409);
    expect(close.body.blockers[0]).toMatchObject({ code: 'remedials', message: '2 remedial(s) not Done' });
    expect(close.body.blockers[0].items.map((x: any) => x.ref)).toEqual([r1.ref, r2.ref]);
    ok(await api.post('/api/recalculate'));
    expect((await actBy((a) => a.id === ctx.gen.id)).status_reason).toMatch(/Critical open remedial/);

    ok(await api.put(`/api/actions/${r1.id}`).send({ state: 'Done', closure_notes: 'Handrail refixed (demo)' }));
    expect(ok(await api.get(`/api/visits/${v.id}`)).status).toBe('complete_remedials'); // one still open
    expect((await api.put(`/api/actions/${r2.id}`).send({ state: 'Done' })).status).toBe(400); // closure details mandatory
    ok(await api.put(`/api/actions/${r2.id}`).send({ state: 'Done', closure_notes: 'Bulb replaced (demo)' }));
    const after = ok(await api.get(`/api/visits/${v.id}`));
    expect(after).toMatchObject({ status: 'closed', blockers: [] });
    expect(after.events[0]).toMatchObject({ event: 'auto_closed' });
    // Closing remedials never recalculates RAG by itself
    expect(await pending()).toBe(true);
    expect((await actBy((a) => a.id === ctx.gen.id)).status_reason).toMatch(/Critical open remedial/);
    ok(await api.post('/api/recalculate'));
    expect((await actBy((a) => a.id === ctx.gen.id)).status).not.toBe('red');
    // Closed visit locks its remedials
    expect((await api.put(`/api/actions/${r1.id}`).send({ state: 'Open' })).status).toBe(409);
    ctx.genVisit = after;
  });

  it('paperwork required: last remedial leaves the visit Awaiting Evidence; upload is not verification; verify then Close', async () => {
    ok(await api.post('/api/recalculate'));
    const gas = await actBy((a) => a.ref === 'PH-C017'); // GAS, evidence required, in date
    let v = ok(await api.post('/api/visits').send({ activity_id: gas.id, provider_name: 'Demo Gas Engineer Ltd (fictional)', performed_on: '2026-11-08' }), 201);
    expect(v.question_count).toBe(0); // statutory activity without a checklist
    const r = ok(await api.post('/api/actions').send({ visit_id: v.id, title: 'Replace worn flue seal (demo)', priority: 'High' }), 201);
    v = ok(await api.post(`/api/visits/${v.id}/complete`).send({ outcome: 'complete_remedials' }));
    expect(v.blockers.map((b: any) => b.code)).toEqual(['remedials', 'evidence']);
    ok(await api.put(`/api/actions/${r.id}`).send({ state: 'Done', closure_notes: 'Seal replaced (demo)' }));
    v = ok(await api.get(`/api/visits/${v.id}`));
    expect(v).toMatchObject({ status: 'awaiting_evidence', status_label: 'Awaiting Evidence', closed_at: null });
    expect(v.blockers.map((b: any) => b.code)).toEqual(['evidence']);
    ok(await api.post('/api/recalculate'));
    let a = await actBy((x) => x.id === gas.id);
    expect(a).toMatchObject({ status: 'grey', status_reason: `Awaiting required evidence for inspection ${v.ref}`, last_done_on: '2026-11-08', next_due_on: '2027-11-08' });

    const doc = ok(await api.post('/api/documents').field('entity_kind', 'inspection').field('entity_id', String(v.id))
      .field('valid_until', '2027-11-08').attach('file', Buffer.from('%PDF-1.4 fictional gas safety record v2'), 'gas-record-v2.pdf'), 201);
    v = ok(await api.get(`/api/visits/${v.id}`));
    expect(v.status).toBe('awaiting_evidence'); // upload alone is not verification
    expect((await api.post(`/api/visits/${v.id}/close`)).status).toBe(409);
    ok(await api.put(`/api/documents/${doc.id}`).send({ verified_by_operator: true }));
    v = ok(await api.get(`/api/visits/${v.id}`));
    expect(v).toMatchObject({ status: 'complete', blockers: [] }); // ready; closing stays a deliberate step
    v = ok(await api.post(`/api/visits/${v.id}/close`));
    expect(v.status).toBe('closed');
    a = await actBy((x) => x.id === gas.id);
    expect(a.status).toBe('grey'); // unchanged until Recalculate
    ok(await api.post('/api/recalculate'));
    a = await actBy((x) => x.id === gas.id);
    expect(a.status).toBe('green');
    // Historical evidence of a closed visit is protected
    expect((await api.put(`/api/documents/${doc.id}`).send({ verified_by_operator: false })).status).toBe(409);
    const link = ok(await api.get(`/api/documents/${doc.id}`)).links.find((l: any) => l.entity_kind === 'inspection');
    expect((await api.delete(`/api/document-links/${link.id}`)).status).toBe(409);
    ctx.gas = gas;
    ctx.gasVisit = v;
  });

  it('a completed but unclosed newer visit never makes the activity look compliant; overdue still wins', async () => {
    const v = ok(await api.post('/api/visits').send({ activity_id: ctx.gas.id, provider_name: 'Engineer', performed_on: TODAY }), 201);
    ok(await api.post(`/api/visits/${v.id}/complete`).send({ outcome: 'complete' }));
    ok(await api.post('/api/recalculate'));
    const a = await actBy((x) => x.id === ctx.gas.id);
    expect(a.status).toBe('grey');
    expect(a.status_reason).toBe(`Awaiting required evidence for inspection ${v.ref}`);
    // Overdue precedence: an overdue activity with a visit merely in progress stays red
    const overdue = await actBy((x) => x.status === 'red' && /^Overdue by/.test(x.status_reason ?? ''));
    const ip = ok(await api.post('/api/visits').send({ activity_id: overdue.id, provider_name: 'X' }), 201);
    ok(await api.post('/api/recalculate'));
    const o = await actBy((x) => x.id === overdue.id);
    expect(o.status).toBe('red');
    expect(o.status_reason).toMatch(new RegExp(`Overdue by \\d+ days? \\(visit ${ip.ref} in progress, not yet completed\\)`));
    ok(await api.delete(`/api/visits/${ip.id}`));
    ctx.unclosed = v;
  });

  it('reopening is deliberate and traceable; reopening work reverts the schedule it set', async () => {
    expect((await api.post(`/api/visits/${ctx.gasVisit.id}/reopen`).send({})).status).toBe(400); // reason required
    let v = ok(await api.post(`/api/visits/${ctx.unclosed.id}/reopen`).send({ scope: 'work', reason: 'Wrong date recorded (demo)' }));
    expect(v).toMatchObject({ status: 'in_progress', outcome: null, completed_at: null });
    const a = await actBy((x) => x.id === ctx.gas.id);
    expect(a).toMatchObject({ last_done_on: '2026-11-08', next_due_on: '2027-11-08', schedule_visit_id: ctx.gasVisit.id });
    v = ok(await api.post(`/api/visits/${ctx.gasVisit.id}/reopen`).send({ scope: 'closure', reason: 'Certificate number queried (demo)' }));
    expect(v).toMatchObject({ status: 'complete', closed_at: null });
    expect(v.events[0]).toMatchObject({ event: 'reopened', reason: 'Certificate number queried (demo)' });
    expect(v.events.some((e: any) => e.event === 'closed')).toBe(true); // history kept
    v = ok(await api.post(`/api/visits/${ctx.gasVisit.id}/close`));
    expect(v.status).toBe('closed');
    const hist = ok(await api.get(`/api/activities/${ctx.gas.id}/history`));
    expect(hist.visits[0].ref).toBe(ctx.unclosed.ref);
    expect(hist.schedule.map((l: any) => l.source)).toContain('visit-reopen');
  });

  it('historical visits keep the checklist version and wording they used', async () => {
    const fireTpl = ok(await api.get('/api/checklists')).find((c: any) => c.code === 'RPI-FIRE');
    const before = ok(await api.get(`/api/visits/${ctx.v.id}`));
    const item = ok(await api.get(`/api/checklists/${fireTpl.id}`)).items[0];
    ok(await api.put(`/api/checklist-items/${item.id}`).send({ question: 'Smoke alarms tested and logged (edited demo wording)' }));
    const after = ok(await api.get(`/api/visits/${ctx.v.id}`));
    expect(after.questions.map((q: any) => q.question)).toEqual(before.questions.map((q: any) => q.question));
    expect(after.checklist_version).toBe(before.checklist_version);
    expect(after.questions[0].question).toBe('Smoke alarms – present, working (test them)');
    const next = ok(await api.post('/api/visits').send({ activity_id: ctx.fire.id, provider_name: 'X' }), 201);
    expect(next.questions[0].question).toBe('Smoke alarms tested and logged (edited demo wording)');
    expect(next.checklist_version).toBe(before.checklist_version + 1);
  });

  it('exports completed visit results as CSV, one row per checklist question', async () => {
    const r = await api.post('/api/export/visits').send({ ids: [ctx.v.id] });
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toMatch(/^Visit,Activity,Type,Area,Site,Room,Performed on/);
  });
});

describe('migration of an existing v0.3 (migration 2) database', () => {
  it('copies legacy routine inspections into visits (same ids), keeps answers, links remedials, flags for review', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(MIGRATIONS[0].sql);
    old.exec(MIGRATIONS[1].sql);
    old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'v1', 'x'), (2, 'v2', 'x');
      INSERT INTO checklist_questions VALUES ('CHK-001','Fire Safety','Smoke alarms – present, working (test them)',1,'INTERNAL','S',2,'PH-PROP-CHECK-001','1.0.0-seed'),
        ('CHK-002','Fire Safety','Carbon monoxide alarms – present where required and working',2,'INTERNAL','S',3,'PH-PROP-CHECK-001','1.0.0-seed');
      INSERT INTO areas (code, name, created_at, updated_at) VALUES ('PH-A001', 'A', 'x', 'x');
      INSERT INTO sites (area_id, code, name, created_at, updated_at) VALUES (1, 'PH-S001', 'S', 'x', 'x');
      INSERT INTO compliance_types (code, name, suggested_interval_months, created_at, updated_at) VALUES ('GAS', 'Gas', 12, 'x', 'x');
      INSERT INTO compliance_activities (ref, type_id, location_level, site_id, last_done_on, next_due_on, created_at, updated_at) VALUES
        ('PH-C001', 1, 'site', 1, '2025-11-04', '2026-11-04', 'x', 'x'), ('PH-C002', 1, 'site', 1, '2025-11-04', '2026-06-01', 'x', 'x');
      INSERT INTO inspection_runs (id, ref, site_id, inspected_on, state, completed_at, created_at, inspector_name) VALUES
        (7, 'PH-I007', 1, '2026-10-01', 'complete', '2026-10-01T10:00:00Z', 'x', 'Old inspector'), (9, 'PH-I009', 1, '2026-11-01', 'draft', NULL, 'x', '');
      INSERT INTO inspection_answers (id, run_id, question_code, response, notes) VALUES (1, 7, 'CHK-001', 'Pass', ''), (2, 7, 'CHK-002', 'Issue', 'No CO alarm');
      INSERT INTO actions (ref, activity_id, inspection_answer_id, inspection_run_id, site_id, title, priority, state, created_at, updated_at) VALUES
        ('PH-X001', NULL, 2, 7, 1, 'Fit CO alarm', 'High', 'Open', 'x', 'x'), ('PH-X002', 1, NULL, NULL, 1, 'Standalone', 'Critical', 'Open', 'x', 'x');
      INSERT INTO documents (id, display_name, storage_key, original_filename, mime_type, size_bytes, sha256, uploaded_at) VALUES (1, 'Photo', 'k', 'p.png', 'image/png', 1, 'h', 'x');
      INSERT INTO document_links (document_id, entity_kind, entity_id, created_at) VALUES (1, 'inspection', 7, 'x');`);
    migrate(old);
    ensureReferenceData(old);
    const visits = old.prepare('SELECT id, ref, activity_id, status, outcome, needs_review, provider_name, legacy_inspection_run_id, checklist_name FROM visits ORDER BY id').all();
    expect(visits).toEqual([
      { id: 7, ref: 'PH-I007', activity_id: null, status: 'complete_remedials', outcome: 'complete_remedials', needs_review: 1, provider_name: 'Old inspector', legacy_inspection_run_id: 7, checklist_name: 'Legacy 30-point routine inspection (PH-PROP-CHECK-001 1.0.0-seed)' },
      { id: 9, ref: 'PH-I009', activity_id: null, status: 'in_progress', outcome: null, needs_review: 1, provider_name: '', legacy_inspection_run_id: 9, checklist_name: 'Legacy 30-point routine inspection (PH-PROP-CHECK-001 1.0.0-seed)' },
    ]);
    expect(old.prepare('SELECT visit_id, item_code, response, notes FROM visit_answers ORDER BY id').all())
      .toEqual([{ visit_id: 7, item_code: 'CHK-001', response: 'Pass', notes: '' }, { visit_id: 7, item_code: 'CHK-002', response: 'Issue', notes: 'No CO alarm' }]);
    expect(old.prepare('SELECT ref, visit_id, question_code, activity_id, needs_review FROM actions ORDER BY id').all()).toEqual([
      { ref: 'PH-X001', visit_id: 7, question_code: 'CHK-002', activity_id: null, needs_review: 0 },
      { ref: 'PH-X002', visit_id: null, question_code: null, activity_id: 1, needs_review: 1 },
    ]);
    expect(old.prepare('SELECT ref, next_due_override FROM compliance_activities ORDER BY ref').all())
      .toEqual([{ ref: 'PH-C001', next_due_override: 0 }, { ref: 'PH-C002', next_due_override: 1 }]);
    expect(old.prepare('SELECT COUNT(*) AS n FROM inspection_runs').get()).toEqual({ n: 2 }); // originals kept
    expect(old.prepare("SELECT COUNT(*) AS n FROM checklist_templates WHERE code LIKE 'RPI-%'").get()).toEqual({ n: 5 });
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a flagged legacy visit can be linked to an activity at its site after review', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-v2-mig-'));
    const d2 = openDb(':memory:');
    ensureReferenceData(d2);
    seedDemo(d2, path.join(tmp, 'u'), TODAY);
    // simulate a legacy visit at PH-S001 without an activity
    const site = (d2.prepare("SELECT id FROM sites WHERE code = 'PH-S001'").get() as any).id;
    d2.prepare(`INSERT INTO visits (ref, site_id, performed_on, status, needs_review, created_at, updated_at) VALUES ('PH-I050', ?, '2026-10-01', 'in_progress', 1, 'x', 'x')`).run(site);
    const a2 = request(createApp({ db: d2, uploadsDir: path.join(tmp, 'u'), outboxDir: path.join(tmp, 'o'), now: () => NOW })) as any;
    const legacy = (await a2.get('/api/visits')).body.find((v: any) => v.ref === 'PH-I050');
    expect(legacy.needs_review).toBe(1);
    expect((await a2.post(`/api/visits/${legacy.id}/complete`).send({ outcome: 'complete' })).status).toBe(400); // must be linked first
    const elsewhere = (await a2.get('/api/activities')).body.find((a: any) => a.site_code === 'PH-S002' && a.type_code === 'RPI');
    expect((await a2.post(`/api/visits/${legacy.id}/link-activity`).send({ activity_id: elsewhere.id })).status).toBe(400);
    const here = (await a2.get('/api/activities')).body.find((a: any) => a.site_code === 'PH-S001' && a.checklist_name === 'Routine — Security');
    const linked = (await a2.post(`/api/visits/${legacy.id}/link-activity`).send({ activity_id: here.id, reason: 'Reviewed (demo)' })).body;
    expect(linked).toMatchObject({ activity_id: here.id, needs_review: 0 });
    expect(linked.events[0]).toMatchObject({ event: 'linked' });
  });
});
