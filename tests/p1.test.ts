// P1 behaviours on the V2 model: seed, v1 upgrade, remedials on visits, the Critical-remedial rule,
// remedial lifecycle and validation, CSV exports.
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
  it('migrates to the latest version and seeds visits in every lifecycle state with refs', async () => {
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r: any) => r.version);
    expect(versions).toEqual([1, 2, 3]);
    const visits = ok(await api.get('/api/visits'));
    const states = new Set(visits.map((v: any) => v.status));
    for (const s of ['closed', 'complete_remedials', 'awaiting_evidence', 'in_progress']) expect(states.has(s)).toBe(true);
    expect(visits.every((v: any) => /^PH-V\d{3}$/.test(v.ref))).toBe(true);
    const remedials = ok(await api.get('/api/actions'));
    expect(remedials.every((a: any) => /^PH-X\d{3}$/.test(a.ref) && a.visit_ref)).toBe(true);
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
    expect(old.prepare('SELECT ref, needs_review FROM actions ORDER BY id').all()).toEqual([{ ref: 'PH-X001', needs_review: 1 }, { ref: 'PH-X002', needs_review: 1 }]);
    expect(old.prepare('SELECT ref, updated_at FROM inspection_runs').get()).toEqual({ ref: 'PH-I001', updated_at: 'x' });
    expect(old.prepare('SELECT id, ref, status, needs_review FROM visits').all()).toEqual([{ id: 1, ref: 'PH-I001', status: 'in_progress', needs_review: 1 }]);
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('remedials and the Critical-remedial rule', () => {
  const ctx: Record<string, any> = {};

  it('a remedial raised on a visit is tied to that visit and its activity', async () => {
    const acts = ok(await api.get('/api/activities'));
    ctx.activity = acts.find((a: any) => a.site_code === 'PH-S003' && a.type_code === 'FRA');
    ok(await api.post('/api/recalculate'));
    ctx.before = ok(await api.get(`/api/activities/${ctx.activity.id}`)).status;
    expect(ctx.before).not.toBe('red');
    ctx.visit = ok(await api.post('/api/visits').send({ activity_id: ctx.activity.id, provider_name: 'Demo fire assessor (fictional)' }), 201);
    expect((await api.post('/api/actions').send({ title: 'No visit' })).status).toBe(400);
    ctx.r = ok(await api.post('/api/actions').send({ visit_id: ctx.visit.id, title: 'Fit CO alarm (demo)', description: 'Boiler cupboard', priority: 'Critical', due_on: '2026-11-10' }), 201);
    expect(ctx.r).toMatchObject({ state: 'Open', priority: 'Critical', activity_ref: ctx.activity.ref, visit_ref: ctx.visit.ref, site_code: 'PH-S003', overdue: false });
  });

  it('does not change status until the next manual Recalculate, then turns the Activity red', async () => {
    expect(ok(await api.get('/api/status')).pending).toBe(true);
    expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe(ctx.before);
    ok(await api.post('/api/recalculate'));
    const a = ok(await api.get(`/api/activities/${ctx.activity.id}`));
    expect(a.status).toBe('red');
    expect(a.status_reason).toMatch(/Critical open remedial/);
  });

  it('Open -> In progress -> Done needs closure details; closing flags pending; next Recalculate clears red', async () => {
    expect(ok(await api.put(`/api/actions/${ctx.r.id}`).send({ state: 'In progress' })).state).toBe('In progress');
    expect((await api.put(`/api/actions/${ctx.r.id}`).send({ state: 'Done' })).status).toBe(400);
    const closed = ok(await api.put(`/api/actions/${ctx.r.id}`).send({ state: 'Done', closure_notes: 'Fitted and tested (demo)' }));
    expect(closed).toMatchObject({ state: 'Done', closed_at: TODAY, closure_notes: 'Fitted and tested (demo)' });
    expect(ok(await api.get('/api/status')).pending).toBe(true);
    expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe('red');
    ok(await api.post('/api/recalculate'));
    expect(ok(await api.get(`/api/activities/${ctx.activity.id}`)).status).toBe(ctx.before);
    const re = ok(await api.put(`/api/actions/${ctx.r.id}`).send({ state: 'Open' }));
    expect(re).toMatchObject({ state: 'Open', closed_at: null, closure_notes: '' });
    ok(await api.put(`/api/actions/${ctx.r.id}`).send({ state: 'Done', closure_notes: 'Fitted (demo)' }));
  });

  it('flags overdue open remedials and validates priority and room', async () => {
    const a = ok(await api.post('/api/actions').send({ visit_id: ctx.visit.id, title: 'Overdue test (demo)', due_on: '2026-11-01', priority: 'Low' }), 201);
    expect(a.overdue).toBe(true);
    expect(a.area_code).toBe('PH-A001');
    expect((await api.post('/api/actions').send({ visit_id: ctx.visit.id, title: 'x', priority: 'Urgent' })).status).toBe(400);
    const otherRoom = ok(await api.get('/api/core')).rooms.find((r: any) => r.site_code !== 'PH-S003');
    expect((await api.post('/api/actions').send({ visit_id: ctx.visit.id, room_id: otherRoom.id, title: 'x' })).status).toBe(400);
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

  it('exports remedials with their inspection and closure details', async () => {
    const r = ok(await api.get('/api/actions')).find((a: any) => a.title === 'Fit CO alarm (demo)');
    const lines = parseCsv((await api.post('/api/export/actions').send({ ids: [r.id] })).text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Inspection \/ visit/);
    expect(lines[1]).toContain(r.ref);
    expect(lines[1]).toContain(r.visit_ref);
    expect(lines[1]).toContain('Fitted (demo)');
  });

  it('exports completed visit results, one row per checklist question; drafts excluded', async () => {
    const closed = ok(await api.get('/api/visits')).find((v: any) => v.status === 'closed' && v.question_count === 8);
    const lines = parseCsv((await api.post('/api/export/visits').send({ ids: [closed.id] })).text);
    expect(lines).toHaveLength(9);
    const draft = ok(await api.get('/api/visits')).find((v: any) => v.status === 'in_progress');
    expect(parseCsv((await api.post('/api/export/visits').send({ ids: [draft.id] })).text)).toHaveLength(1);
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
