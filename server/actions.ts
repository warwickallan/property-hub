// Remedial actions (P1). An open Critical action linked to an Activity turns that Activity red,
// but only at the NEXT manual recalculation (see recalculate.ts). Saving an action only marks
// changes pending; it never alters a status snapshot.
import type { Express } from 'express';
import type { DB } from './db.js';
import { optDate } from './dates.js';
import { bad, h, HttpError, idParam, notFound, optInt, optStr, reqInt, reqStr } from './http.js';
import { toCsv, sendCsv } from './csv.js';
import type { Ctx } from './inspections.js';

type Row = Record<string, any>;
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export const STATES = ['Open', 'In progress', 'Done'] as const;

const ACTION_SELECT = `
  SELECT x.*, act.ref AS activity_ref, act.name AS activity_name, t.code AS activity_type_code,
         s.code AS site_code, s.name AS site_name, rm.code AS room_code, rm.name AS room_name,
         ar.id AS area_id, ar.code AS area_code, ar.name AS area_name,
         u.name AS owner_name, u.email AS owner_email,
         i.ref AS inspection_ref, i.inspected_on AS inspection_date,
         q.code AS question_code, q.question AS question_text, q.group_name AS question_group
  FROM actions x
  LEFT JOIN compliance_activities act ON act.id = x.activity_id
  LEFT JOIN compliance_types t ON t.id = act.type_id
  LEFT JOIN sites s ON s.id = x.site_id
  LEFT JOIN rooms rm ON rm.id = x.room_id
  LEFT JOIN areas ar ON ar.id = COALESCE(s.area_id, act.area_id)
  LEFT JOIN users u ON u.id = x.owner_user_id
  LEFT JOIN inspection_runs i ON i.id = x.inspection_run_id
  LEFT JOIN inspection_answers ia ON ia.id = x.inspection_answer_id
  LEFT JOIN checklist_questions q ON q.code = ia.question_code`;

export function listActions(db: DB, today: string, where = '1=1', params: unknown[] = []): Row[] {
  return (db.prepare(
    `${ACTION_SELECT} WHERE ${where}
     ORDER BY CASE x.state WHEN 'Done' THEN 1 ELSE 0 END,
              CASE x.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
              x.due_on IS NULL, x.due_on, x.id`,
  ).all(...params) as Row[]).map((a) => ({ ...a, overdue: a.state !== 'Done' && !!a.due_on && a.due_on < today }));
}

export function registerActions(app: Express, ctx: Ctx) {
  const { db, ts } = ctx;
  const get = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const one = (id: number) => listActions(db, ctx.today(), 'x.id = ?', [id])[0];

  /** Resolve and validate the action's location context, activity and inspection source. */
  const resolve = (b: Row, cur?: Row) => {
    const pick = (k: string) => (b[k] !== undefined ? optInt(b[k], k) : (cur?.[k] ?? null));
    let siteId = pick('site_id');
    let roomId = pick('room_id');
    const activityId = pick('activity_id');
    const runId = pick('inspection_run_id');
    let answerId = pick('inspection_answer_id');

    if (runId !== null) {
      const run = get('SELECT * FROM inspection_runs WHERE id = ?', runId);
      if (!run) throw notFound('Inspection');
      if (siteId !== null && siteId !== run.site_id) throw bad('Action site must match the source inspection site');
      siteId = run.site_id;
      if (roomId === null && b.room_id === undefined) roomId = run.room_id;
      if (b.question_code !== undefined && b.question_code !== null && b.question_code !== '') {
        const ans = get('SELECT * FROM inspection_answers WHERE run_id = ? AND question_code = ?', runId, String(b.question_code));
        if (!ans) throw bad(`Question ${b.question_code} has not been answered on this inspection`);
        answerId = ans.id;
      }
    }
    if (answerId !== null) {
      const ans = get('SELECT * FROM inspection_answers WHERE id = ?', answerId);
      if (!ans) throw notFound('Inspection answer');
      if (runId !== null && ans.run_id !== runId) throw bad('Inspection answer belongs to a different inspection');
      if (ans.response !== 'Issue' && !cur) throw bad('Remedial actions can only be raised from a question recorded as Issue');
    }

    let act: Row | undefined;
    if (activityId !== null) {
      act = get(
        `SELECT a.*, COALESCE(a.site_id, r.site_id) AS eff_site, COALESCE(a.area_id, s.area_id) AS eff_area
         FROM compliance_activities a LEFT JOIN rooms r ON r.id = a.room_id LEFT JOIN sites s ON s.id = COALESCE(a.site_id, r.site_id) WHERE a.id = ?`,
        activityId,
      );
      if (!act) throw notFound('Activity');
      if (siteId === null && act.eff_site) siteId = act.eff_site;
      if (roomId === null && act.location_level === 'room' && b.room_id === undefined && !cur) roomId = act.room_id;
    }
    if (siteId !== null && !get('SELECT id FROM sites WHERE id = ?', siteId)) throw notFound('Site');
    if (roomId !== null) {
      const r = get('SELECT site_id FROM rooms WHERE id = ?', roomId);
      if (!r) throw notFound('Room');
      if (siteId === null) siteId = r.site_id;
      if (r.site_id !== siteId) throw bad('The selected Room is not in the action\'s Site');
    }
    if (act && siteId !== null) {
      const site = get('SELECT area_id FROM sites WHERE id = ?', siteId)!;
      const related = act.location_level === 'area' ? act.eff_area === site.area_id : act.eff_site === siteId;
      if (!related) throw bad(`${act.ref} is not at this location. Link an activity at the same Site (or its Area).`);
    }
    if (siteId === null && !act) throw bad('An action needs a Site (or a linked Activity)');
    return { siteId, roomId, activityId, runId, answerId };
  };

  const ownerOf = (b: Row, cur?: Row) => {
    const owner = b.owner_user_id !== undefined ? optInt(b.owner_user_id, 'Owner') : (cur?.owner_user_id ?? null);
    if (owner !== null && !get('SELECT id FROM users WHERE id = ?', owner)) throw notFound('Owner');
    return owner;
  };
  const priorityOf = (v: unknown, d: string) => {
    const p = v !== undefined && v !== null && v !== '' ? String(v) : d;
    if (!(PRIORITIES as readonly string[]).includes(p)) throw bad(`Priority must be one of ${PRIORITIES.join(', ')}`);
    return p;
  };

  app.get('/api/actions', h((_req, res) => res.json(listActions(db, ctx.today()))));
  app.get('/api/actions/:id', h((req, res) => {
    const a = one(idParam(req));
    if (!a) throw notFound('Action');
    res.json(a);
  }));

  app.post('/api/actions', h((req, res) => {
    const b = req.body ?? {};
    const r = resolve(b);
    const state = b.state ? String(b.state) : 'Open';
    if (state === 'Done') throw bad('New actions start Open or In progress');
    if (!(STATES as readonly string[]).includes(state)) throw bad('Invalid status');
    const id = Number(db.prepare(
      `INSERT INTO actions (ref, activity_id, inspection_answer_id, inspection_run_id, site_id, room_id, title, description, priority, owner_user_id,
         due_on, state, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ctx.nextCode('actions', 'ref', 'PH-X'), r.activityId, r.answerId, r.runId, r.siteId, r.roomId, reqStr(b.title, 'Title'), optStr(b.description),
      priorityOf(b.priority, 'Medium'), ownerOf(b), optDate(b.due_on, 'Due date'), state, optStr(b.notes), ts(), ts()).lastInsertRowid);
    res.status(201).json(one(id));
  }));

  app.put('/api/actions/:id', h((req, res) => {
    const id = idParam(req);
    const cur = get('SELECT * FROM actions WHERE id = ?', id);
    if (!cur) throw notFound('Action');
    const b = req.body ?? {};
    const r = resolve(b, cur);
    const state = b.state !== undefined ? String(b.state) : cur.state;
    if (!(STATES as readonly string[]).includes(state)) throw bad(`Status must be one of ${STATES.join(', ')}`);
    let closure = b.closure_notes !== undefined ? optStr(b.closure_notes) : cur.closure_notes;
    let closedAt = cur.closed_at;
    if (state === 'Done') {
      if (!closure) throw bad('Closure details are required to mark an action Done (what was done, by whom)');
      if (cur.state !== 'Done') closedAt = optDate(b.closed_on, 'Closed on') ?? ctx.today();
    } else {
      closedAt = null;
      if (cur.state === 'Done' && b.closure_notes === undefined) closure = '';
    }
    db.prepare(
      `UPDATE actions SET title = ?, description = ?, priority = ?, owner_user_id = ?, due_on = ?, state = ?, notes = ?, closure_notes = ?, closed_at = ?,
         activity_id = ?, site_id = ?, room_id = ?, updated_at = ? WHERE id = ?`,
    ).run(b.title !== undefined ? reqStr(b.title, 'Title') : cur.title, b.description !== undefined ? optStr(b.description) : cur.description,
      priorityOf(b.priority, cur.priority), ownerOf(b, cur), b.due_on !== undefined ? optDate(b.due_on, 'Due date') : cur.due_on, state,
      b.notes !== undefined ? optStr(b.notes) : cur.notes, closure, closedAt, r.activityId, r.siteId, r.roomId, ts(), id);
    res.json(one(id));
  }));

  app.delete('/api/actions/:id', h((req, res) => {
    const id = idParam(req);
    const cur = get('SELECT * FROM actions WHERE id = ?', id);
    if (!cur) throw notFound('Action');
    if (cur.state === 'Done') throw new HttpError(409, 'Closed actions are kept as history');
    db.transaction(() => {
      db.prepare("DELETE FROM document_links WHERE entity_kind = 'action' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM actions WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  }));

  app.post('/api/export/actions', h((req, res) => {
    const all = listActions(db, ctx.today());
    const ids: number[] | null = Array.isArray(req.body?.ids) ? req.body.ids.map((x: unknown) => reqInt(x, 'id')) : null;
    const byId = new Map(all.map((a) => [a.id, a]));
    const rows = ids ? ids.map((i) => byId.get(i)).filter((a): a is Row => !!a) : all;
    sendCsv(res, 'actions.csv', toCsv(rows, [
      { header: 'Ref', value: (a) => a.ref },
      { header: 'Title', value: (a) => a.title },
      { header: 'Description', value: (a) => a.description },
      { header: 'Priority', value: (a) => a.priority },
      { header: 'Status', value: (a) => a.state },
      { header: 'Overdue', value: (a) => (a.overdue ? 'Yes' : 'No') },
      { header: 'Due on', value: (a) => a.due_on },
      { header: 'Owner', value: (a) => a.owner_name },
      { header: 'Area', value: (a) => a.area_code },
      { header: 'Site', value: (a) => (a.site_code ? `${a.site_code} ${a.site_name}` : '') },
      { header: 'Room', value: (a) => (a.room_code ? `${a.room_code} ${a.room_name}` : '') },
      { header: 'Activity', value: (a) => a.activity_ref },
      { header: 'Source inspection', value: (a) => a.inspection_ref },
      { header: 'Source question', value: (a) => (a.question_code ? `${a.question_code} ${a.question_text}` : '') },
      { header: 'Created', value: (a) => a.created_at?.slice(0, 10) },
      { header: 'Closed on', value: (a) => a.closed_at?.slice(0, 10) },
      { header: 'Closure details', value: (a) => a.closure_notes },
      { header: 'Notes', value: (a) => a.notes },
    ]));
  }));
}
