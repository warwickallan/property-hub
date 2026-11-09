// P1: routine inspections, remedial actions, Critical-action status rule and CSV exports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../server/db';
import { createApp } from '../server/app';
import { ensureReferenceData, seedDemo } from '../server/seed';
import { csvCell, toCsv } from '../server/csv';

const NOW = new Date('2026-11-08T10:00:00Z');
const TODAY = '2026-11-08';
let db: DB;
let api: ReturnType<typeof request>;

beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-p1-'));
  db = openDb(':memory:');
  ensureReferenceData(db);
  seedDemo(db, path.join(tmp, 'uploads'), TODAY);
  api = request(createApp({ db, uploadsDir: path.join(tmp, 'uploads'), outboxDir: path.join(tmp, 'outbox'), now: () => NOW })) as unknown as ReturnType<typeof request>;
});

const ok = (r: request.Response, code = 200) => {
  if (r.status !== code) throw new Error(`Expected ${code}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const parseCsv = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n');

describe('seed', () => {
  it('migrates to the latest version and seeds a completed and a draft inspection with refs', async () => {
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r: any) => r.version);
    expect(versions).toEqual([1, 2, 3]);
    const runs = ok(await api.get('/api/inspections'));
    expect(runs.map((r: any) => [r.ref, r.state]).sort()).toEqual([['PH-I001', 'complete'], ['PH-I002', 'draft']]);
    const actions = ok(await api.get('/api/actions'));
    expect(actions.every((a: any) => /^PH-X\d{3}$/.test(a.ref))).toBe(true);
    expect(actions.find((a: any) => a.inspection_ref === 'PH-I001')?.question_code).toBe('CHK-005');
  });
});

describe('migration', () => {
  it('upgrades a P0 (v1) database with existing actions and inspections in place', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { MIGRATIONS } = await import('../server/migrations');
    const { migrate } = await import('../server/db');
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(MIGRATIONS[0].sql);
    old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'v1', 'x');
      INSERT INTO areas (code, name, created_at, updated_at) VALUES ('PH-A001', 'A', 'x', 'x');
      INSERT INTO sites (area_id, code, name, created_at, updated_at) VALUES (1, 'PH-S001', 'S', 'x', 'x');
      INSERT INTO actions (site_id, title, created_at, updated_at) VALUES (1, 'Old action', 'x', 'x'), (1, 'Another', 'x', 'x');
      INSERT INTO inspection_runs (site_id, inspected_on, created_at) VALUES (1, '2026-01-01', 'x');`);
    migrate(old);
    expect(old.prepare('SELECT ref FROM actions ORDER BY id').all()).toEqual([{ ref: 'PH-X001' }, { ref: 'PH-X002' }]);
    expect(old.prepare('SELECT ref, updated_at FROM inspection_runs').get()).toEqual({ ref: 'PH-I001', updated_at: 'x' });
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('routine inspections', () => {
  const ctx: Record<string, any> = {};

  it('starts a Site inspection, scoped to a Room, and validates inspector and room', async () => {
    const core = ok(await api.get('/api/core'));
    ctx.site = core.sites.find((s: any) => s.code === 'PH-S003');
    ctx.room = core.rooms.find((r: any) => r.site_id === ctx.site.id);
    ctx.otherRoom = core.rooms.find((r: any) => r.site_id !== ctx.site.id);
    ctx.user = core.users.find((u: any) => u.role_label === 'Team Leader');
    expect((await api.post('/api/inspections').send({ site_id: ctx.site.id })).status).toBe(400); // no inspector
    expect((await api.post('/api/inspections').send({ site_id: ctx.site.id, room_id: ctx.otherRoom.id, inspector_name: 'X' })).status).toBe(400);
    const run = ok(await api.post('/api/inspections').send({ site_id: ctx.site.id, room_id: ctx.room.id, inspector_user_id: ctx.user.id, inspected_on: '2026-11-07' }), 201);
    expect(run).toMatchObject({ state: 'draft', inspected_on: '2026-11-07', inspector: ctx.user.name, answered: 0, question_count: 30 });
    expect(run.questions).toHaveLength(30);
    expect(run.groups).toEqual(['Fire Safety', 'Security', 'Gas, Electrical & Utilities', 'Health & Wellbeing Risks', 'General Property Safety']);
    expect(run.unanswered).toHaveLength(30);
    ctx.run = run;
  });

  it('keeps the exact original question wording', async () => {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/inspection_template_seed.json'), 'utf8'));
    const run = ok(await api.get(`/api/inspections/${ctx.run.id}`));
    expect(run.questions.map((q: any) => [q.code, q.group_name, q.question])).toEqual(seed.questions.map((q: any) => [q.code, q.group, q.question]));
  });

  it('saves draft answers with notes, resumes them, and reports progress', async () => {
    const before = ok(await api.get('/api/status')).pending;
    const saved = ok(await api.put(`/api/inspections/${ctx.run.id}/answers`).send({ answers: [
      { question_code: 'CHK-001', response: 'Pass' },
      { question_code: 'CHK-002', response: 'Issue', notes: 'CO alarm missing in boiler cupboard (demo)' },
      { question_code: 'CHK-003', response: 'Not applicable' },
    ] }));
    expect(saved.answered).toBe(3);
    expect(saved.issues).toBe(1);
    expect(saved.unanswered).toHaveLength(27);
    const resumed = ok(await api.get(`/api/inspections/${ctx.run.id}`));
    expect(resumed.questions[1]).toMatchObject({ code: 'CHK-002', response: 'Issue', notes: 'CO alarm missing in boiler cupboard (demo)' });
    // Clearing returns a question to unanswered; invalid responses rejected
    expect(ok(await api.put(`/api/inspections/${ctx.run.id}/answers`).send({ answers: [{ question_code: 'CHK-003', response: '' }] })).answered).toBe(2);
    expect((await api.put(`/api/inspections/${ctx.run.id}/answers`).send({ answers: [{ question_code: 'CHK-004', response: 'Fail' }] })).status).toBe(400);
    expect((await api.put(`/api/inspections/${ctx.run.id}/answers`).send({ answers: [{ question_code: 'CHK-999', response: 'Pass' }] })).status).toBe(400);
    // Routine inspections never affect compliance status: no pending flag
    expect(ok(await api.get('/api/status')).pending).toBe(before);
  });

  it('refuses completion while questions are unanswered, then completes and locks', async () => {
    const r = await api.post(`/api/inspections/${ctx.run.id}/complete`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/28 question\(s\) still unanswered: CHK-003/);
    const rest = ok(await api.get(`/api/inspections/${ctx.run.id}`)).unanswered.map((c: string) => ({ question_code: c, response: 'Not checked' }));
    ok(await api.put(`/api/inspections/${ctx.run.id}/answers`).send({ answers: rest }));
    const done = ok(await api.post(`/api/inspections/${ctx.run.id}/complete`));
    expect(done.state).toBe('complete');
    expect(done.completed_at).toBeTruthy();
    expect((await api.put(`/api/inspections/${ctx.run.id}/answers`).send({ answers: [{ question_code: 'CHK-001', response: 'Issue' }] })).status).toBe(409);
    const hist = ok(await api.get(`/api/inspections?site_id=${ctx.site.id}`));
    expect(hist.map((x: any) => x.id)).toContain(ctx.run.id);
  });

  it('reopens a completed inspection for correction and links library documents', async () => {
    expect(ok(await api.post(`/api/inspections/${ctx.run.id}/reopen`)).state).toBe('draft');
    const doc = ok(await api.post('/api/documents').field('entity_kind', 'inspection').field('entity_id', String(ctx.run.id))
      .attach('file', Buffer.from('fictional inspection photo log'), 'inspection-notes.txt'), 201);
    expect(doc.links[0]).toMatchObject({ entity_kind: 'inspection', href: `#/inspections/${ctx.run.id}` });
    expect(ok(await api.get(`/api/inspections/${ctx.run.id}`)).doc_count).toBe(1);
    ok(await api.post(`/api/inspections/${ctx.run.id}/complete`));
  });

  it('deletes only empty drafts', async () => {
    const d = ok(await api.post('/api/inspections').send({ site_id: ctx.site.id, inspector_name: 'Visiting contractor (demo)' }), 201);
    expect(d.inspector).toBe('Visiting contractor (demo)');
    ok(await api.delete(`/api/inspections/${d.id}`));
    expect((await api.get(`/api/inspections/${d.id}`)).status).toBe(404);
    expect((await api.delete(`/api/inspections/${ctx.run.id}`)).status).toBe(409); // completed
  });

  describe('remedial actions and the Critical-action rule', () => {
    it('creates a Critical action from an Issue answer, linked to an Activity at the same Site', async () => {
      ok(await api.post(`/api/inspections/${ctx.run.id}/reopen`));
      // Only Issue answers can raise remedial actions
      expect((await api.post('/api/actions').send({ inspection_run_id: ctx.run.id, question_code: 'CHK-001', title: 'x' })).status).toBe(400);
      const acts = ok(await api.get('/api/activities'));
      ctx.activity = acts.find((a: any) => a.site_id === ctx.site.id && a.type_code === 'FRA');
      const elsewhere = acts.find((a: any) => a.site_id && a.site_id !== ctx.site.id);
      expect((await api.post('/api/actions').send({ inspection_run_id: ctx.run.id, question_code: 'CHK-002', title: 'x', activity_id: elsewhere.id })).status).toBe(400);

      ok(await api.post('/api/recalculate'));
      ctx.before = ok(await api.get(`/api/activities/${ctx.activity.id}`));
      expect(ctx.before.status).not.toBe('red');

      ctx.action = ok(await api.post('/api/actions').send({
        inspection_run_id: ctx.run.id, question_code: 'CHK-002', activity_id: ctx.activity.id, title: 'Fit CO alarm (demo)',
        description: 'Boiler cupboard has no CO alarm', priority: 'Critical', owner_user_id: ctx.user.id, due_on: '2026-11-10',
      }), 201);
      expect(ctx.action).toMatchObject({
        state: 'Open', priority: 'Critical', site_id: ctx.site.id, room_id: ctx.room.id, inspection_ref: ctx.run.ref,
        question_code: 'CHK-002', activity_ref: ctx.activity.ref, owner_name: ctx.user.name, overdue: false,
      });
      expect(ctx.action.ref).toMatch(/^PH-X\d{3}$/);
      const q = ok(await api.get(`/api/inspections/${ctx.run.id}`)).questions.find((x: any) => x.code === 'CHK-002');
      expect(q.actions.map((a: any) => a.id)).toEqual([ctx.action.id]);
      // An answer with a linked action cannot be cleared
      expect((await api.put(`/api/inspections/${ctx.run.id}/answers`).send({ answers: [{ question_code: 'CHK-002', response: '' }] })).status).toBe(409);
    });

    it('does not change status until the next manual Recalculate, then turns the Activity red', async () => {
      expect(ok(await api.get('/api/status')).pending).toBe(true);
      expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe(ctx.before.status);
      ok(await api.post('/api/recalculate'));
      const a = ok(await api.get(`/api/activities/${ctx.activity.id}`));
      expect(a.status).toBe('red');
      expect(a.status_reason).toMatch(/Critical open action/);
    });

    it('moves Open -> In progress -> Done with closure details; closing flags pending; next Recalculate clears red', async () => {
      expect(ok(await api.put(`/api/actions/${ctx.action.id}`).send({ state: 'In progress' })).state).toBe('In progress');
      ok(await api.post('/api/recalculate'));
      expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe('red'); // still open
      expect((await api.put(`/api/actions/${ctx.action.id}`).send({ state: 'Done' })).status).toBe(400); // closure details required
      const closed = ok(await api.put(`/api/actions/${ctx.action.id}`).send({ state: 'Done', closure_notes: 'CO alarm fitted and tested (demo)' }));
      expect(closed).toMatchObject({ state: 'Done', closed_at: TODAY, closure_notes: 'CO alarm fitted and tested (demo)' });
      expect(ok(await api.get('/api/status')).pending).toBe(true);
      expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe('red'); // unchanged until Recalculate
      ok(await api.post('/api/recalculate'));
      expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe(ctx.before.status);
      // Reopening clears closure; Critical again -> red at next run
      const re = ok(await api.put(`/api/actions/${ctx.action.id}`).send({ state: 'Open' }));
      expect(re).toMatchObject({ state: 'Open', closed_at: null, closure_notes: '' });
      ok(await api.post('/api/recalculate'));
      expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe('red');
      ok(await api.put(`/api/actions/${ctx.action.id}`).send({ state: 'Done', closure_notes: 'Fitted (demo)' }));
      ok(await api.post('/api/recalculate'));
    });

    it('flags overdue open actions and validates priority, room and site', async () => {
      const a = ok(await api.post('/api/actions').send({ site_id: ctx.site.id, title: 'Overdue test (demo)', due_on: '2026-11-01', priority: 'Low' }), 201);
      expect(a.overdue).toBe(true);
      expect(a.area_code).toBe('PH-A001');
      expect((await api.post('/api/actions').send({ site_id: ctx.site.id, title: 'x', priority: 'Urgent' })).status).toBe(400);
      expect((await api.post('/api/actions').send({ site_id: ctx.site.id, room_id: ctx.otherRoom.id, title: 'x' })).status).toBe(400);
      expect((await api.post('/api/actions').send({ title: 'No location' })).status).toBe(400);
      ok(await api.delete(`/api/actions/${a.id}`));
    });
  });

  describe('CSV exports', () => {
    it('exports the filtered activities register in the given order', async () => {
      const acts = ok(await api.get('/api/activities'));
      const pick = [acts[5].id, acts[0].id];
      const r = await api.post('/api/export/activities').send({ ids: pick });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/compliance-activities\.csv/);
      const lines = parseCsv(r.text);
      expect(lines[0]).toMatch(/^Ref,Area,Site,Room,Level,Type/);
      expect(lines).toHaveLength(3);
      expect(lines[1].startsWith(acts[5].ref + ',')).toBe(true);
      expect(lines[2].startsWith(acts[0].ref + ',')).toBe(true);
    });

    it('exports actions with source inspection and closure details', async () => {
      const r = await api.post('/api/export/actions').send({ ids: [ctx.action.id] });
      const lines = parseCsv(r.text);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(ctx.action.ref);
      expect(lines[1]).toContain(ctx.run.ref);
      expect(lines[1]).toContain('Fitted (demo)');
    });

    it('exports completed inspection results, 30 rows per inspection', async () => {
      ok(await api.post(`/api/inspections/${ctx.run.id}/complete`));
      const r = await api.post('/api/export/inspections').send({ ids: [ctx.run.id] });
      const lines = parseCsv(r.text);
      expect(lines).toHaveLength(31);
      expect(lines[0]).toBe('Inspection,Inspected on,Completed at,Inspector,Area,Site,Room,Question code,Category,Question,Response,Notes,Remedial actions');
      expect(lines.find((l) => l.includes('CHK-002'))).toContain(ctx.action.ref);
      const all = parseCsv((await api.post('/api/export/inspections').send({})).text);
      expect(all).toHaveLength(1 + 30 * 2); // seeded PH-I001 + this one; drafts excluded
    });

    it('escapes CSV and neutralises spreadsheet formulas', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
      expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
      expect(csvCell('+1')).toBe("'+1");
      expect(csvCell('-3')).toBe('-3');
      expect(csvCell(null)).toBe('');
      expect(toCsv([{ a: 1 }], [{ header: 'A', value: (r) => r.a }])).toBe('﻿A\r\n1\r\n');
    });
  });
});
