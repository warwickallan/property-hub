// Remedials (stored in the historical "actions" table). V2: every new remedial belongs to an
// Inspection / Visit, and through it to that visit's Compliance Activity (fixed, not user-editable),
// optionally to a checklist question, room and equipment. An open Critical remedial affects that
// activity at the NEXT manual Recalculate. Resolving the final remedial re-evaluates the visit's
// closure (auto-close or Awaiting Evidence) but never recalculates RAG status.
import type { Express } from 'express';
import type { DB } from './db.js';
import { optDate } from './dates.js';
import { bad, h, HttpError, idParam, notFound, optInt, optStr, reqInt, reqStr } from './http.js';
import { toCsv, sendCsv } from './csv.js';
import { syncVisit, VISIT_STATUS_LABEL, type Ctx, type SnapshotItem } from './visits.js';

type Row = Record<string, any>;
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export const STATES = ['Open', 'In progress', 'Done'] as const;

const ACTION_SELECT = `
  SELECT x.*, act.ref AS activity_ref, act.name AS activity_name, t.code AS activity_type_code,
         s.code AS site_code, s.name AS site_name, rm.code AS room_code, rm.name AS room_name,
         ar.id AS area_id, ar.code AS area_code, ar.name AS area_name,
         u.name AS owner_name, u.email AS owner_email,
         v.ref AS visit_ref, v.status AS visit_status, v.performed_on AS visit_date, v.checklist_snapshot AS visit_snapshot,
         e.asset_code AS equipment_code, e.description AS equipment_description,
         q.question AS legacy_question_text, q.group_name AS legacy_question_group
  FROM actions x
  LEFT JOIN compliance_activities act ON act.id = x.activity_id
  LEFT JOIN compliance_types t ON t.id = act.type_id
  LEFT JOIN visits v ON v.id = x.visit_id
  LEFT JOIN sites s ON s.id = x.site_id
  LEFT JOIN rooms rm ON rm.id = x.room_id
  LEFT JOIN areas ar ON ar.id = COALESCE(s.area_id, act.area_id)
  LEFT JOIN users u ON u.id = x.owner_user_id
  LEFT JOIN equipment e ON e.id = x.equipment_id
  LEFT JOIN checklist_questions q ON q.code = x.question_code`;

export function listActions(db: DB, today: string, where = '1=1', params: unknown[] = []): Row[] {
  return (db.prepare(
    `${ACTION_SELECT} WHERE ${where}
     ORDER BY CASE x.state WHEN 'Done' THEN 1 ELSE 0 END,
              CASE x.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
              x.due_on IS NULL, x.due_on, x.id`,
  ).all(...params) as Row[]).map((a) => {
    const snap: SnapshotItem[] = a.visit_snapshot ? JSON.parse(a.visit_snapshot) : [];
    const q = a.question_code ? snap.find((i) => i.code === a.question_code) : undefined;
    const { visit_snapshot: _drop, ...rest } = a;
    return {
      ...rest,
      question_text: q?.question ?? a.legacy_question_text ?? null,
      question_group: q?.section ?? a.legacy_question_group ?? null,
      visit_status_label: a.visit_status ? VISIT_STATUS_LABEL[a.visit_status] : null,
      overdue: a.state !== 'Done' && !!a.due_on && a.due_on < today,
    };
  });
}

export function registerActions(app: Express, ctx: Ctx) {
  const { db, ts } = ctx;
  const get = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const one = (id: number) => listActions(db, ctx.today(), 'x.id = ?', [id])[0];

  const visitContext = (visitId: number) => {
    const v = get('SELECT * FROM visits WHERE id = ?', visitId);
    if (!v) throw notFound('Inspection / visit');
    return v;
  };
  const assertVisitOpen = (v: Row | undefined) => {
    if (v?.closed_at) throw new HttpError(409, `${v.ref} is closed. Reopen the inspection deliberately before changing its remedials.`);
  };
  const locate = (b: Row, v: Row | null, cur?: Row) => {
    const siteId: number | null = v ? v.site_id : (cur?.site_id ?? null);
    let roomId = b.room_id !== undefined ? optInt(b.room_id, 'Room') : (cur?.room_id ?? (v ? v.room_id : null));
    if (roomId !== null) {
      const r = get('SELECT site_id FROM rooms WHERE id = ?', roomId);
      if (!r) throw notFound('Room');
      if (siteId !== null && r.site_id !== siteId) throw bad('The selected Room is not at this inspection\'s Site');
    }
    const equipmentId = b.equipment_id !== undefined ? optInt(b.equipment_id, 'Equipment') : (cur?.equipment_id ?? null);
    if (equipmentId !== null) {
      const e = get('SELECT e.room_id, r.site_id FROM equipment e JOIN rooms r ON r.id = e.room_id WHERE e.id = ?', equipmentId);
      if (!e) throw notFound('Equipment');
      if (siteId !== null && e.site_id !== siteId) throw bad('The selected equipment is not at this inspection\'s Site');
      if (roomId === null) roomId = e.room_id;
    }
    return { siteId, roomId, equipmentId };
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
    if (!a) throw notFound('Remedial');
    res.json(a);
  }));

  app.post('/api/actions', h((req, res) => {
    const b = req.body ?? {};
    const visitId = b.visit_id !== undefined ? optInt(b.visit_id, 'Inspection') : null;
    if (visitId === null) throw bad('A remedial must be raised from an Inspection / Visit (visit_id)');
    const v = visitContext(visitId);
    assertVisitOpen(v);
    if (b.activity_id !== undefined && b.activity_id !== null && Number(b.activity_id) !== v.activity_id) {
      throw bad('A remedial is linked to its inspection\'s Compliance Activity; it cannot be pointed at another activity');
    }
    const questionCode = optStr(b.question_code) || null;
    if (questionCode) {
      const snap: SnapshotItem[] = JSON.parse(v.checklist_snapshot || '[]');
      if (!snap.some((q) => q.code === questionCode)) throw bad(`Question ${questionCode} is not on ${v.ref}'s checklist`);
      const ans = get('SELECT response FROM visit_answers WHERE visit_id = ? AND item_code = ?', visitId, questionCode);
      if (ans?.response !== 'Issue') throw bad('Remedials can only be raised against a checklist question answered Issue');
    }
    const loc = locate(b, v);
    const state = b.state ? String(b.state) : 'Open';
    if (state === 'Done') throw bad('New remedials start Open or In progress');
    if (!(STATES as readonly string[]).includes(state)) throw bad('Invalid status');
    const id = db.transaction(() => {
      const nid = Number(db.prepare(
        `INSERT INTO actions (ref, activity_id, visit_id, question_code, site_id, room_id, equipment_id, title, description, priority, owner_user_id,
           due_on, state, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(ctx.nextCode('actions', 'ref', 'PH-X'), v.activity_id, visitId, questionCode, loc.siteId, loc.roomId, loc.equipmentId, reqStr(b.title, 'Title'),
        optStr(b.description), priorityOf(b.priority, 'Medium'), ownerOf(b), optDate(b.due_on, 'Due date'), state, optStr(b.notes), ts(), ts()).lastInsertRowid);
      // A remedial raised after the work was recorded as "complete" turns it into "complete with remedials".
      if (v.completed_at && v.outcome === 'complete') {
        db.prepare("UPDATE visits SET outcome = 'complete_remedials', updated_at = ? WHERE id = ?").run(ts(), visitId);
        db.prepare('INSERT INTO visit_events (visit_id, at, event, detail) VALUES (?, ?, ?, ?)').run(visitId, ts(), 'remedial_added', 'Remedial raised after completion; outcome is now Complete with Remedials');
      }
      syncVisit(db, visitId, ts(), 'other');
      return nid;
    })();
    res.status(201).json(one(id));
  }));

  app.put('/api/actions/:id', h((req, res) => {
    const id = idParam(req);
    const cur = get('SELECT * FROM actions WHERE id = ?', id);
    if (!cur) throw notFound('Remedial');
    const v = cur.visit_id ? visitContext(cur.visit_id) : null;
    assertVisitOpen(v ?? undefined);
    const b = req.body ?? {};
    if (b.activity_id !== undefined && (b.activity_id === null ? null : Number(b.activity_id)) !== cur.activity_id) {
      throw bad('The Compliance Activity of a remedial comes from its inspection and cannot be changed here');
    }
    const loc = locate(b, v, cur);
    const state = b.state !== undefined ? String(b.state) : cur.state;
    if (!(STATES as readonly string[]).includes(state)) throw bad(`Status must be one of ${STATES.join(', ')}`);
    let closure = b.closure_notes !== undefined ? optStr(b.closure_notes) : cur.closure_notes;
    let closedAt = cur.closed_at;
    if (state === 'Done') {
      if (!closure) throw bad('Closure details are required to mark a remedial Done (what was done, by whom)');
      if (cur.state !== 'Done') closedAt = optDate(b.closed_on, 'Closed on') ?? ctx.today();
    } else {
      closedAt = null;
      if (cur.state === 'Done' && b.closure_notes === undefined) closure = '';
    }
    db.transaction(() => {
      db.prepare(
        `UPDATE actions SET title = ?, description = ?, priority = ?, owner_user_id = ?, due_on = ?, state = ?, notes = ?, closure_notes = ?, closed_at = ?,
           room_id = ?, equipment_id = ?, updated_at = ? WHERE id = ?`,
      ).run(b.title !== undefined ? reqStr(b.title, 'Title') : cur.title, b.description !== undefined ? optStr(b.description) : cur.description,
        priorityOf(b.priority, cur.priority), ownerOf(b, cur), b.due_on !== undefined ? optDate(b.due_on, 'Due date') : cur.due_on, state,
        b.notes !== undefined ? optStr(b.notes) : cur.notes, closure, closedAt, loc.roomId, loc.equipmentId, ts(), id);
      if (cur.visit_id) syncVisit(db, cur.visit_id, ts(), state !== cur.state ? 'remedial' : 'other');
    })();
    res.json(one(id));
  }));

  app.delete('/api/actions/:id', h((req, res) => {
    const id = idParam(req);
    const cur = get('SELECT * FROM actions WHERE id = ?', id);
    if (!cur) throw notFound('Remedial');
    if (cur.state === 'Done') throw new HttpError(409, 'Done remedials are kept as history');
    const v = cur.visit_id ? visitContext(cur.visit_id) : null;
    assertVisitOpen(v ?? undefined);
    db.transaction(() => {
      db.prepare("DELETE FROM document_links WHERE entity_kind = 'action' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM actions WHERE id = ?').run(id);
      if (cur.visit_id) syncVisit(db, cur.visit_id, ts(), 'other');
    })();
    res.json({ ok: true });
  }));

  app.post('/api/export/actions', h((req, res) => {
    const all = listActions(db, ctx.today());
    const ids: number[] | null = Array.isArray(req.body?.ids) ? req.body.ids.map((x: unknown) => reqInt(x, 'id')) : null;
    const byId = new Map(all.map((a) => [a.id, a]));
    const rows = ids ? ids.map((i) => byId.get(i)).filter((a): a is Row => !!a) : all;
    sendCsv(res, 'remedials.csv', toCsv(rows, [
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
      { header: 'Equipment', value: (a) => a.equipment_code },
      { header: 'Inspection / visit', value: (a) => a.visit_ref },
      { header: 'Visit status', value: (a) => a.visit_status_label },
      { header: 'Activity', value: (a) => a.activity_ref },
      { header: 'Checklist question', value: (a) => (a.question_code ? `${a.question_code} ${a.question_text ?? ''}` : '') },
      { header: 'Created', value: (a) => a.created_at?.slice(0, 10) },
      { header: 'Closed on', value: (a) => a.closed_at?.slice(0, 10) },
      { header: 'Closure details', value: (a) => a.closure_notes },
      { header: 'Notes', value: (a) => a.notes },
      { header: 'Needs review', value: (a) => (a.needs_review ? 'Yes' : '') },
    ]));
  }));
}
