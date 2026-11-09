// P1.1 regression: PH-C012 date-edit bug, derived next due + override, compliance checks with amendments,
// current-cycle evidence, migration 3. All data fictional; isolated in-memory databases.
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
import { derivedNextDue, effectiveNextDue } from '../server/schedule';

const NOW = new Date('2026-11-09T10:00:00Z');
const TODAY = '2026-11-09';
let db: DB;
let api: ReturnType<typeof request>;

beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-p11-'));
  db = openDb(':memory:');
  ensureReferenceData(db);
  seedDemo(db, path.join(tmp, 'uploads'), TODAY);
  api = request(createApp({ db, uploadsDir: path.join(tmp, 'uploads'), outboxDir: path.join(tmp, 'outbox'), now: () => NOW })) as unknown as ReturnType<typeof request>;
});

const ok = (r: request.Response, code = 200) => {
  if (r.status !== code) throw new Error(`Expected ${code}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const act = async (ref: string) => (ok(await api.get('/api/activities')) as any[]).find((a) => a.ref === ref);
const pending = async () => ok(await api.get('/api/status')).pending as boolean;
/** Exactly what the v0.4 Edit form sends. */
const formBody = (a: any, patch: Record<string, unknown>) => ({
  type_id: a.type_id, location_level: a.location_level, location_id: a[`${a.location_level}_id`], name: a.name, owner_user_id: a.owner_user_id,
  last_done_on: a.last_done_on, expires_on: a.expires_on, interval_months: a.interval_months, applicability: a.applicability, na_reason: a.na_reason, notes: a.notes,
  next_due_override: !!a.next_due_override, next_due_on: a.next_due_override ? a.next_due_on : null, next_due_override_reason: a.next_due_override_reason, ...patch,
});

describe('date arithmetic', () => {
  it('derives next due by calendar months with month-end clamping', () => {
    expect(derivedNextDue('2025-11-04', 12)).toBe('2026-11-04');
    expect(derivedNextDue('2026-01-31', 1)).toBe('2026-02-28');
    expect(derivedNextDue('2027-01-31', 13)).toBe('2028-02-29'); // leap year
    expect(derivedNextDue('2024-02-29', 12)).toBe('2025-02-28');
    expect(derivedNextDue('2026-08-31', 6)).toBe('2027-02-28');
    expect(derivedNextDue('2026-03-31', 60)).toBe('2031-03-31');
    expect(derivedNextDue(null, 12)).toBeNull();
    expect(derivedNextDue('2026-01-01', null)).toBeNull();
  });
  it('uses the activity interval before the type default, and an override when set', () => {
    expect(effectiveNextDue({ last_done_on: '2026-01-15', interval_months: 6, type_interval: 12, next_due_override: false, override_date: null }))
      .toEqual({ next_due_on: '2026-07-15', derived: '2026-07-15' });
    expect(effectiveNextDue({ last_done_on: '2026-01-15', interval_months: null, type_interval: 12, next_due_override: true, override_date: '2026-12-01' }))
      .toEqual({ next_due_on: '2026-12-01', derived: '2027-01-15' });
  });
});

describe('PH-C012 Gas Safety date edit (operator defect)', () => {
  let c12: any;

  it('seeded PH-C012 is overdue with a derived (not override) schedule and a historical check', async () => {
    ok(await api.post('/api/recalculate'));
    c12 = await act('PH-C012');
    expect(c12).toMatchObject({ type_code: 'GAS', site_code: 'PH-S003', last_done_on: '2025-11-04', next_due_on: '2026-11-04', next_due_override: 0, status: 'red' });
    expect(c12.status_reason).toBe('Overdue by 5 days');
    expect(c12.latest_check).toMatchObject({ outcome: 'Satisfactory', performed_on: '2025-11-04' });
  });

  it('editing Last done derives and persists the new next due, flags pending, leaves the snapshot alone', async () => {
    expect(await pending()).toBe(false);
    const saved = ok(await api.put(`/api/activities/${c12.id}`).send(formBody(c12, { last_done_on: TODAY })));
    expect(saved).toMatchObject({ last_done_on: TODAY, next_due_on: '2027-11-09', next_due_override: 0, derived_next_due: '2027-11-09' });
    expect(await pending()).toBe(true);
    const reloaded = ok(await api.get(`/api/activities/${c12.id}`));
    expect(reloaded).toMatchObject({ last_done_on: TODAY, next_due_on: '2027-11-09', status: 'red', snap_due_on: '2026-11-04' });
    const row = db.prepare('SELECT last_done_on, next_due_on, next_due_override FROM compliance_activities WHERE id = ?').get(c12.id);
    expect(row).toEqual({ last_done_on: TODAY, next_due_on: '2027-11-09', next_due_override: 0 });
    const hist = ok(await api.get(`/api/activities/${c12.id}/history`));
    expect(hist.schedule[0]).toMatchObject({ source: 'edit', old_last_done: '2025-11-04', new_last_done: TODAY, old_next_due: '2026-11-04', new_next_due: '2027-11-09' });
  });

  it('manual Recalculate uses the persisted next due; the previous cycle certificate no longer forces Overdue', async () => {
    ok(await api.post('/api/recalculate'));
    const a = ok(await api.get(`/api/activities/${c12.id}`));
    expect(a.snap_due_on).toBe('2027-11-09');
    expect(a.status).not.toBe('red');
    expect(a.status).toBe('grey'); // gas certificate from 2025 is not evidence for the new cycle
    expect(a.status_reason).toMatch(/Required evidence missing for the current cycle/);
    expect(await pending()).toBe(false);
  });

  it('an explicit override is stored, flagged, needs a date, and is used by Recalculate', async () => {
    const cur = ok(await api.get(`/api/activities/${c12.id}`));
    expect((await api.put(`/api/activities/${c12.id}`).send(formBody(cur, { next_due_override: true, next_due_on: null }))).status).toBe(400);
    const o = ok(await api.put(`/api/activities/${c12.id}`).send(formBody(cur, { next_due_override: true, next_due_on: '2027-06-30', next_due_override_reason: 'Engineer booked early (demo)' })));
    expect(o).toMatchObject({ next_due_on: '2027-06-30', next_due_override: 1, next_due_override_reason: 'Engineer booked early (demo)', derived_next_due: '2027-11-09' });
    ok(await api.post('/api/recalculate'));
    expect(ok(await api.get(`/api/activities/${c12.id}`)).snap_due_on).toBe('2027-06-30');
    // Untick override -> back to derived
    const back = ok(await api.put(`/api/activities/${c12.id}`).send(formBody(o, { next_due_override: false })));
    expect(back).toMatchObject({ next_due_on: '2027-11-09', next_due_override: 0, next_due_override_reason: '' });
    // Future last-done rejected
    expect((await api.put(`/api/activities/${c12.id}`).send(formBody(back, { last_done_on: '2026-11-10' }))).status).toBe(400);
  });

  it('older API callers sending only next_due_on are treated as an explicit override (not silently ignored)', async () => {
    const legacy = ok(await api.put(`/api/activities/${c12.id}`).send({ next_due_on: '2027-05-01' }));
    expect(legacy).toMatchObject({ next_due_on: '2027-05-01', next_due_override: 1 });
    const back = ok(await api.put(`/api/activities/${c12.id}`).send({ next_due_override: false }));
    expect(back.next_due_on).toBe('2027-11-09');
  });
});

describe('compliance inspection / check workflow', () => {
  const ctx: Record<string, any> = {};

  it('records a Gas Safety check with an uploaded (unverified) certificate and updates the schedule, not the status', async () => {
    ok(await api.post('/api/recalculate'));
    ctx.a = await act('PH-C017'); // PH-S004 Plant Room gas, in date
    ctx.before = ctx.a.status;
    const users = ok(await api.get('/api/users'));
    ctx.engineer = users.find((u: any) => u.role_label === 'Team Leader');
    const doc = ok(await api.post('/api/documents').attach('file', Buffer.from('%PDF-1.4 fictional gas safety record 2026'), 'gas-safety-2026.pdf'), 201);
    expect(doc.verified_by_operator).toBe(0);
    const proposal = ok(await api.get(`/api/activities/${ctx.a.id}/check-proposal?performed_on=2026-11-02`));
    expect(proposal).toEqual({ interval_months: 12, proposed_next_due: '2027-11-02' });

    ctx.check = ok(await api.post('/api/checks').send({
      activity_id: ctx.a.id, performed_on: '2026-11-02', inspector_user_id: ctx.engineer.id, provider_name: 'Demo Gas Engineer Ltd (fictional)',
      outcome: 'Satisfactory', notes: 'Boiler serviced, CO alarm tested (demo)', certificate_document_id: doc.id, certificate_valid_until: '2027-11-02',
    }), 201);
    expect(ctx.check).toMatchObject({ outcome: 'Satisfactory', proposed_next_due: '2027-11-02', next_due_on: '2027-11-02', schedule_applied: 1,
      previous_last_done: ctx.a.last_done_on, previous_next_due: ctx.a.next_due_on, certificate_verified: 0, activity_ref: 'PH-C017', type_code: 'GAS' });
    expect(ctx.check.ref).toMatch(/^PH-K\d{3}$/);
    const a = ok(await api.get(`/api/activities/${ctx.a.id}`));
    expect(a).toMatchObject({ last_done_on: '2026-11-02', next_due_on: '2027-11-02', next_due_override: 0, schedule_check_id: ctx.check.id, status: ctx.before });
    expect(await pending()).toBe(true);
    // certificate linked once to the activity as evidence, issued on the performed date
    const docs = ok(await api.get(`/api/documents?entity_kind=activity&entity_id=${ctx.a.id}`));
    expect(docs.find((d: any) => d.id === doc.id)).toMatchObject({ link_role: 'certificate', issued_on: '2026-11-02', valid_until: '2027-11-02' });
    ctx.doc = doc;
  });

  it('an unverified certificate never produces green; verifying it does, at the next Recalculate', async () => {
    ok(await api.post('/api/recalculate'));
    let a = ok(await api.get(`/api/activities/${ctx.a.id}`));
    expect(a.status).toBe('grey');
    expect(a.status_reason).toMatch(/not reviewed\/verified/);
    expect(a.snap_due_on).toBe('2027-11-02');
    ok(await api.put(`/api/documents/${ctx.doc.id}`).send({ verified_by_operator: true }));
    expect(ok(await api.get(`/api/activities/${ctx.a.id}`)).status).toBe('grey'); // unchanged until Recalculate
    ok(await api.post('/api/recalculate'));
    a = ok(await api.get(`/api/activities/${ctx.a.id}`));
    expect(a.status).toBe('green');
  });

  it('the real inspection appears in history (latest first) separately from calculation snapshots', async () => {
    const h = ok(await api.get(`/api/activities/${ctx.a.id}/history`));
    expect(h.checks[0]).toMatchObject({ id: ctx.check.id, performed_on: '2026-11-02' });
    expect(h.checks[1].performed_on < h.checks[0].performed_on).toBe(true); // seeded earlier check
    expect(h.schedule[0]).toMatchObject({ source: 'check', check_id: ctx.check.id, new_last_done: '2026-11-02' });
    expect(h.snapshots.length).toBeGreaterThanOrEqual(3);
    expect(new Set(h.snapshots.map((s: any) => s.run_id)).size).toBe(h.snapshots.length); // one snapshot per manual run
    expect(h.snapshots[0].run_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // full timestamp available to the UI
  });

  it('amends a check through a traceable superseding record; the original is preserved', async () => {
    expect((await api.post(`/api/checks/${ctx.check.id}/amend`).send({ performed_on: '2026-11-01' })).status).toBe(400); // reason required
    const original = db.prepare('SELECT * FROM compliance_checks WHERE id = ?').get(ctx.check.id) as any;
    const am = ok(await api.post(`/api/checks/${ctx.check.id}/amend`).send({ performed_on: '2026-11-01', amendment_reason: 'Engineer record shows 01/11 (demo)' }), 201);
    expect(am).toMatchObject({ amends_check_id: ctx.check.id, amendment_reason: 'Engineer record shows 01/11 (demo)', performed_on: '2026-11-01',
      next_due_on: '2027-11-01', outcome: 'Satisfactory', certificate_document_id: ctx.doc.id, schedule_applied: 1 });
    const after = db.prepare('SELECT * FROM compliance_checks WHERE id = ?').get(ctx.check.id) as any;
    expect({ ...after, superseded_by_id: null }).toEqual(original); // nothing rewritten except the pointer
    expect(after.superseded_by_id).toBe(am.id);
    expect(ok(await api.get(`/api/activities/${ctx.a.id}`))).toMatchObject({ last_done_on: '2026-11-01', next_due_on: '2027-11-01', schedule_check_id: am.id });
    expect((await api.post(`/api/checks/${ctx.check.id}/amend`).send({ amendment_reason: 'again' })).status).toBe(409);
    const h = ok(await api.get(`/api/activities/${ctx.a.id}/history`));
    expect(h.schedule[0]).toMatchObject({ source: 'amendment', check_id: am.id });
    expect(h.schedule[0].note).toMatch(new RegExp(`Amends ${ctx.check.ref}`));
    // No in-place edit or delete routes exist for checks
    expect((await api.put(`/api/checks/${am.id}`).send({ outcome: 'Unsatisfactory' })).status).toBe(404);
    expect((await api.delete(`/api/checks/${am.id}`)).status).toBe(404);
    ctx.amended = am;
  });

  it('amending the outcome to Not completed restores the schedule from before the original check', async () => {
    const before = ok(await api.get(`/api/activities/${ctx.a.id}`));
    const am2 = ok(await api.post(`/api/checks/${ctx.amended.id}/amend`).send({ outcome: 'Not completed', amendment_reason: 'Visit aborted, no access (demo)' }), 201);
    const a = ok(await api.get(`/api/activities/${ctx.a.id}`));
    expect(a.last_done_on).toBe(ctx.check.previous_last_done);
    expect(a.next_due_on).toBe(ctx.check.previous_next_due);
    expect(a.last_done_on).not.toBe(before.last_done_on);
    expect(am2.schedule_applied).toBe(0);
  });

  it('Not completed checks keep history without moving the schedule; Unsatisfactory turns red at the next Recalculate', async () => {
    const a0 = await act('PH-C022');
    const nc = ok(await api.post('/api/checks').send({ activity_id: a0.id, performed_on: TODAY, provider_name: 'Demo contractor (fictional)', outcome: 'Not completed', notes: 'No access' }), 201);
    expect(nc.schedule_applied).toBe(0);
    expect(ok(await api.get(`/api/activities/${a0.id}`))).toMatchObject({ last_done_on: a0.last_done_on, next_due_on: a0.next_due_on });

    ok(await api.post('/api/recalculate'));
    const before = ok(await api.get(`/api/activities/${a0.id}`)).status;
    const bad = ok(await api.post('/api/checks').send({ activity_id: a0.id, performed_on: TODAY, provider_name: 'Demo contractor (fictional)', outcome: 'Unsatisfactory', notes: 'Flue defect (demo)' }), 201);
    expect(ok(await api.get(`/api/activities/${a0.id}`))).toMatchObject({ last_done_on: TODAY, next_due_on: '2027-11-09', status: before });
    ok(await api.post('/api/recalculate'));
    const a = ok(await api.get(`/api/activities/${a0.id}`));
    expect(a.status).toBe('red');
    expect(a.status_reason).toBe(`Latest check ${bad.ref} (09/11/2026) was unsatisfactory`);
  });

  it('a retrospective check older than the current last done is kept as history only', async () => {
    const a0 = await act('PH-C001');
    const old = ok(await api.post('/api/checks').send({ activity_id: a0.id, performed_on: '2025-01-10', provider_name: 'Archive entry (demo)', outcome: 'Satisfactory' }), 201);
    expect(old.schedule_applied).toBe(0);
    expect(ok(await api.get(`/api/activities/${a0.id}`))).toMatchObject({ last_done_on: a0.last_done_on, next_due_on: a0.next_due_on });
  });

  it('validates check input', async () => {
    const a0 = await act('PH-C001');
    const base = { activity_id: a0.id, performed_on: TODAY, provider_name: 'X', outcome: 'Satisfactory' };
    expect((await api.post('/api/checks').send({ ...base, performed_on: '2026-11-10' })).status).toBe(400);
    expect((await api.post('/api/checks').send({ ...base, provider_name: '' })).status).toBe(400);
    expect((await api.post('/api/checks').send({ ...base, outcome: 'Pass' })).status).toBe(400);
    expect((await api.post('/api/checks').send({ ...base, next_due_override: true, next_due_on: '2027-01-01' })).status).toBe(400); // reason
    const o = ok(await api.post('/api/checks').send({ ...base, next_due_override: true, next_due_on: '2027-03-31', override_reason: 'Align with annual contract (demo)' }), 201);
    expect(o).toMatchObject({ next_due_override: 1, next_due_on: '2027-03-31', proposed_next_due: '2027-11-09' });
    expect(ok(await api.get(`/api/activities/${a0.id}`))).toMatchObject({ next_due_on: '2027-03-31', next_due_override: 1 });
  });

  it('changing a type default interval re-derives activities that follow it', async () => {
    const pat = ok(await api.get('/api/types')).find((t: any) => t.code === 'PAT');
    const a0 = await act('PH-C003');
    expect(a0.next_due_override).toBe(0);
    ok(await api.put(`/api/types/${pat.id}`).send({ suggested_interval_months: 6 }));
    const a = ok(await api.get(`/api/activities/${a0.id}`));
    expect(a.next_due_on).toBe(derivedNextDue(a0.last_done_on, 6));
    ok(await api.put(`/api/types/${pat.id}`).send({ suggested_interval_months: 12 }));
  });
});

describe('migration 3 on an existing v2 database', () => {
  it('classifies legacy schedules without changing any dates', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(MIGRATIONS[0].sql);
    old.exec(MIGRATIONS[1].sql);
    old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'v1', 'x'), (2, 'v2', 'x');
      INSERT INTO areas (code, name, created_at, updated_at) VALUES ('PH-A001', 'A', 'x', 'x');
      INSERT INTO sites (area_id, code, name, created_at, updated_at) VALUES (1, 'PH-S001', 'S', 'x', 'x');
      INSERT INTO compliance_types (code, name, suggested_interval_months, created_at, updated_at) VALUES ('GAS', 'Gas', 12, 'x', 'x');
      INSERT INTO compliance_activities (ref, type_id, location_level, site_id, last_done_on, next_due_on, created_at, updated_at) VALUES
        ('PH-C001', 1, 'site', 1, '2025-11-04', '2026-11-04', 'x', 'x'),
        ('PH-C002', 1, 'site', 1, '2025-11-04', '2026-06-01', 'x', 'x'),
        ('PH-C003', 1, 'site', 1, '2025-01-31', NULL, 'x', 'x');`);
    migrate(old);
    const rows = old.prepare('SELECT ref, last_done_on, next_due_on, next_due_override FROM compliance_activities ORDER BY ref').all();
    expect(rows).toEqual([
      { ref: 'PH-C001', last_done_on: '2025-11-04', next_due_on: '2026-11-04', next_due_override: 0 },
      { ref: 'PH-C002', last_done_on: '2025-11-04', next_due_on: '2026-06-01', next_due_override: 1 },
      { ref: 'PH-C003', last_done_on: '2025-01-31', next_due_on: '2026-01-31', next_due_override: 0 },
    ]);
    expect(old.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r: any) => r.version)).toEqual([1, 2, 3]);
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
