// End-to-end API workflow against an in-memory SQLite DB and temp folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../server/db';
import { createApp } from '../server/app';
import { ensureReferenceData, seedDemo } from '../server/seed';

const NOW = new Date('2026-11-08T10:00:00Z');
const TODAY = '2026-11-08';
let db: DB;
let api: ReturnType<typeof request>;
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-test-'));
  db = openDb(':memory:');
  ensureReferenceData(db);
  seedDemo(db, path.join(tmp, 'uploads'), TODAY);
  const app = createApp({ db, uploadsDir: path.join(tmp, 'uploads'), outboxDir: path.join(tmp, 'outbox'), now: () => NOW });
  api = request(app) as unknown as ReturnType<typeof request>;
});

const ok = (r: request.Response, code = 200) => {
  if (r.status !== code) throw new Error(`Expected ${code}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

describe('seed + schema', () => {
  it('seeds v0.3 fictional data and no flat schema', async () => {
    const core = ok(await api.get('/api/core'));
    expect(core.areas).toHaveLength(2);
    expect(core.sites).toHaveLength(10);
    expect(core.types.map((t: { code: string }) => t.code).sort()).toEqual(['EICR', 'FRA', 'GAS', 'LEG', 'PAT']);
    expect(core.areas[0].code).toBe('PH-A001');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).not.toContain('properties');
    expect(tables).not.toContain('property_checks');
    expect((ok(await api.get('/api/checklist')) as unknown[]).length).toBe(30);
  });
  it('enforces exactly one location FK at DB level', () => {
    expect(() => db.prepare(`INSERT INTO compliance_activities (ref, type_id, location_level, site_id, room_id, created_at, updated_at)
      VALUES ('X1', 1, 'site', 1, 1, 'x', 'x')`).run()).toThrow(/CHECK/);
  });
  it('shows Not yet calculated before first run', async () => {
    const s = ok(await api.get('/api/status'));
    expect(s.lastRun).toBeNull();
    const acts = ok(await api.get('/api/activities'));
    expect(acts[0].status).toBeNull();
  });
});

describe('acceptance-critical workflow', () => {
  const ctx: Record<string, any> = {};

  it('A. Admin creates Area / Site / Rooms, equipment in a Room', async () => {
    ctx.area = ok(await api.post('/api/areas').send({ name: 'North' }), 201);
    expect(ctx.area.code).toBe('PH-A003');
    ctx.site = ok(await api.post('/api/sites').send({ area_id: ctx.area.id, name: 'Demo House 11' }), 201);
    ctx.kitchen = ok(await api.post('/api/rooms').send({ site_id: ctx.site.id, name: 'Kitchen' }), 201);
    ctx.office = ok(await api.post('/api/rooms').send({ site_id: ctx.site.id, name: 'Office' }), 201);
    ctx.kettle = ok(await api.post('/api/equipment').send({ room_id: ctx.kitchen.id, description: 'Kettle 001', category: 'Portable appliance' }), 201);
    expect(ctx.kettle.site_code).toBe(ctx.site.code);
    // Equipment must have a room
    expect((await api.post('/api/equipment').send({ description: 'Orphan' })).status).toBe(400);
    // Parent deletion is blocked while children exist
    expect((await api.delete(`/api/areas/${ctx.area.id}`)).status).toBe(409);
  });

  it('B/F. Creates a Site-level PAT activity with a Team Leader and linked equipment', async () => {
    ctx.tl = ok(await api.post('/api/users').send({ name: 'Test Team Leader', email: 'tl.test@example.test', role_label: 'Team Leader' }), 201);
    const pat = ok(await api.get('/api/types')).find((t: any) => t.code === 'PAT');
    ctx.act = ok(await api.post('/api/activities').send({
      type_id: pat.id, location_level: 'site', location_id: ctx.site.id, name: 'PAT 2027', owner_user_id: ctx.tl.id,
      next_due_on: '2027-06-01', equipment_ids: [ctx.kettle.id],
    }), 201);
    expect(ctx.act.equipment_count).toBe(1);
    expect(ctx.act.site_code).toBe(ctx.site.code);
    const sheet = ok(await api.get(`/api/locations/site/${ctx.site.id}`));
    expect(sheet.activities.map((a: any) => a.id)).toContain(ctx.act.id);
  });

  it('G. Rejects equipment from outside the activity scope', async () => {
    const roomAct = ok(await api.post('/api/activities').send({ type_id: 1, location_level: 'room', location_id: ctx.office.id }), 201);
    const r = await api.post(`/api/activities/${roomAct.id}/equipment`).send({ equipment_ids: [ctx.kettle.id] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/outside this activity's room scope/);
  });

  it('C. Uploads one document and links the same file to Activity, Equipment and Site', async () => {
    const before = fs.readdirSync(path.join(tmp, 'uploads')).length;
    const doc = ok(await api.post('/api/documents').field('entity_kind', 'activity').field('entity_id', String(ctx.act.id))
      .field('valid_until', '2027-12-31').attach('file', Buffer.from('%PDF-1.4 sample certificate'), 'sample-certificate.pdf'), 201);
    ok(await api.post(`/api/documents/${doc.id}/links`).send({ entity_kind: 'equipment', entity_id: ctx.kettle.id }), 201);
    const linked = ok(await api.post(`/api/documents/${doc.id}/links`).send({ entity_kind: 'site', entity_id: ctx.site.id }), 201);
    expect(linked.links.map((l: any) => l.entity_kind).sort()).toEqual(['activity', 'equipment', 'site']);
    expect(fs.readdirSync(path.join(tmp, 'uploads')).length).toBe(before + 1);
    // Re-uploading the same bytes reuses the existing document (no duplicate file)
    const again = ok(await api.post('/api/documents').attach('file', Buffer.from('%PDF-1.4 sample certificate'), 'copy.pdf'));
    expect(again.reused).toBe(true);
    expect(again.id).toBe(doc.id);
    expect(fs.readdirSync(path.join(tmp, 'uploads')).length).toBe(before + 1);
    // Link to a missing entity is rejected; disallowed type rejected
    expect((await api.post(`/api/documents/${doc.id}/links`).send({ entity_kind: 'room', entity_id: 99999 })).status).toBe(404);
    expect((await api.post('/api/documents').attach('file', Buffer.from('x'), 'evil.html')).status).toBe(400);
    const file = await api.get(`/api/documents/${doc.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    ctx.doc = doc;
  });

  it('D. Edit due date -> pending, snapshot unchanged until Recalculate; then RAG + reminder draft', async () => {
    ok(await api.post('/api/recalculate'));
    let s = ok(await api.get('/api/status'));
    expect(s.pending).toBe(false);
    let a = ok(await api.get(`/api/activities/${ctx.act.id}`));
    expect(a.status).toBe('grey'); // document uploaded but NOT verified: upload is not verification
    expect(a.status_reason).toMatch(/not reviewed\/verified/);

    ok(await api.put(`/api/documents/${ctx.doc.id}`).send({ verified_by_operator: true }));
    ok(await api.put(`/api/activities/${ctx.act.id}`).send({ next_due_on: TODAY }));
    s = ok(await api.get('/api/status'));
    expect(s.pending).toBe(true);
    a = ok(await api.get(`/api/activities/${ctx.act.id}`));
    expect(a.status).toBe('grey'); // old snapshot retained
    expect(a.next_due_on).toBe(TODAY);

    const run = ok(await api.post('/api/recalculate'));
    expect(run.totals.total).toBeGreaterThan(50);
    a = ok(await api.get(`/api/activities/${ctx.act.id}`));
    expect(a.status).toBe('amber');
    expect(a.status_reason).toBe('Due today');
    expect(ok(await api.get('/api/status')).pending).toBe(false);

    ok(await api.put(`/api/activities/${ctx.act.id}`).send({ next_due_on: '2026-11-07' }));
    ok(await api.post('/api/recalculate'));
    a = ok(await api.get(`/api/activities/${ctx.act.id}`));
    expect(a.status).toBe('red');

    const rem = ok(await api.get('/api/reminders'));
    ctx.cand = rem.candidates.find((c: any) => c.activity_id === ctx.act.id);
    expect(ctx.cand).toMatchObject({ recipient_email: 'tl.test@example.test', threshold: 'overdue' });
    expect(ctx.cand.draft_text).toContain(ctx.act.ref);
    expect(fs.existsSync(path.join(tmp, 'outbox'))).toBe(false); // Recalculate sends nothing
  });

  it('Reminders: export draft, demo send, duplicate guard, resend override', async () => {
    const exp = ok(await api.post('/api/reminders/export').send({ ids: [ctx.cand.id] }));
    expect(exp.results[0].outcome).toBe('exported');
    const eml = await api.get(`/api/reminders/${ctx.cand.id}/eml`);
    expect(eml.text).toContain('X-Unsent: 1');
    expect(ok(await api.post('/api/reminders/send').send({ ids: [ctx.cand.id] })).results[0].outcome).toBe('sent');
    expect(ok(await api.post('/api/reminders/send').send({ ids: [ctx.cand.id] })).results[0].outcome).toBe('skipped_duplicate');
    expect(ok(await api.post('/api/reminders/send').send({ ids: [ctx.cand.id], resend: true })).results[0].outcome).toBe('sent');
    const noRecipient = ok(await api.get('/api/reminders')).candidates.find((c: any) => !c.recipient_email);
    if (noRecipient) expect(ok(await api.post('/api/reminders/send').send({ ids: [noRecipient.id] })).results[0].outcome).toBe('failed');
    const outbox = fs.readdirSync(path.join(tmp, 'outbox')).filter((f) => f.endsWith('.eml'));
    expect(outbox).toHaveLength(2);
  });

  it('Critical action makes activity red at next recalculation', async () => {
    ok(await api.put(`/api/activities/${ctx.act.id}`).send({ next_due_on: '2027-06-01' }));
    ok(await api.post('/api/actions').send({ activity_id: ctx.act.id, title: 'Kettle cable damaged', priority: 'Critical' }), 201);
    ok(await api.post('/api/recalculate'));
    expect(ok(await api.get(`/api/activities/${ctx.act.id}`)).status_reason).toMatch(/Critical/);
  });

  it('E. New compliance type usable for a Room activity', async () => {
    const t = ok(await api.post('/api/types').send({ code: 'EML', name: 'Emergency Lighting', suggested_interval_months: 12 }), 201);
    const a = ok(await api.post('/api/activities').send({ type_id: t.id, location_level: 'room', location_id: ctx.kitchen.id }), 201);
    expect(a.type_name).toBe('Emergency Lighting');
    expect(a.room_code).toBe(ctx.kitchen.code);
  });

  it('Moving equipment surfaces now-invalid activity links', async () => {
    const otherRoom = ok(await api.get('/api/core')).rooms.find((r: any) => r.site_id !== ctx.site.id);
    const moved = ok(await api.put(`/api/equipment/${ctx.kettle.id}`).send({ room_id: otherRoom.id }));
    expect(moved.scope_warnings.map((w: any) => w.id)).toContain(ctx.act.id);
    const a = ok(await api.get(`/api/activities/${ctx.act.id}`));
    expect(a.equipment[0].in_scope).toBe(false);
  });
});
