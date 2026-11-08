// Routine 30-point visual inspections (P1). A routine inspection is a record of what was observed;
// it never counts as statutory compliance evidence and never changes compliance status by itself.
import type { Express } from 'express';
import type { DB } from './db.js';
import { optDate } from './dates.js';
import { bad, h, HttpError, idParam, notFound, optInt, optStr, reqInt } from './http.js';
import { listActions } from './actions.js';
import { toCsv, sendCsv } from './csv.js';

type Row = Record<string, any>;
export const RESPONSES = ['Pass', 'Issue', 'Not applicable', 'Not checked'] as const;

export interface Ctx {
  db: DB;
  ts: () => string;
  today: () => string;
  nextCode: (table: string, col: string, prefix: string) => string;
}

const RUN_SELECT = `
  SELECT i.*, COALESCE(u.name, NULLIF(i.inspector_name, '')) AS inspector,
         s.code AS site_code, s.name AS site_name, s.area_id, ar.code AS area_code, ar.name AS area_name,
         r.code AS room_code, r.name AS room_name,
         (SELECT COUNT(*) FROM checklist_questions) AS question_count,
         (SELECT COUNT(*) FROM inspection_answers x WHERE x.run_id = i.id) AS answered,
         (SELECT COUNT(*) FROM inspection_answers x WHERE x.run_id = i.id AND x.response = 'Issue') AS issues,
         (SELECT COUNT(*) FROM inspection_answers x WHERE x.run_id = i.id AND x.response = 'Pass') AS passes,
         (SELECT COUNT(*) FROM actions a WHERE a.inspection_run_id = i.id) AS action_count,
         (SELECT COUNT(*) FROM actions a WHERE a.inspection_run_id = i.id AND a.state <> 'Done') AS open_actions,
         (SELECT COUNT(*) FROM document_links l WHERE l.entity_kind = 'inspection' AND l.entity_id = i.id) AS doc_count
  FROM inspection_runs i
  JOIN sites s ON s.id = i.site_id
  JOIN areas ar ON ar.id = s.area_id
  LEFT JOIN rooms r ON r.id = i.room_id
  LEFT JOIN users u ON u.id = i.inspector_user_id`;

export function listInspections(db: DB, where = '1=1', params: unknown[] = []): Row[] {
  return db.prepare(`${RUN_SELECT} WHERE ${where} ORDER BY i.inspected_on DESC, i.id DESC`).all(...params) as Row[];
}

export function inspectionDetail(db: DB, id: number, today: string) {
  const run = listInspections(db, 'i.id = ?', [id])[0];
  if (!run) throw notFound('Inspection');
  const questions = db.prepare(
    `SELECT q.code, q.group_name, q.question, q.sort_order, a.id AS answer_id, a.response, a.notes
     FROM checklist_questions q LEFT JOIN inspection_answers a ON a.question_code = q.code AND a.run_id = ?
     ORDER BY q.sort_order`,
  ).all(id) as Row[];
  const actions = listActions(db, today, 'x.inspection_run_id = ?', [id]);
  const groups: string[] = [];
  for (const q of questions) if (!groups.includes(q.group_name)) groups.push(q.group_name);
  return {
    ...run,
    groups,
    questions: questions.map((q) => ({ ...q, actions: actions.filter((a) => a.inspection_answer_id === q.answer_id && q.answer_id) })),
    unanswered: questions.filter((q) => !q.response).map((q) => q.code),
    actions,
  };
}

export function registerInspections(app: Express, ctx: Ctx) {
  const { db, ts } = ctx;
  const get = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;

  const mustRun = (id: number) => {
    const r = get('SELECT * FROM inspection_runs WHERE id = ?', id);
    if (!r) throw notFound('Inspection');
    return r;
  };
  const mustDraft = (r: Row) => {
    if (r.state !== 'draft') throw new HttpError(409, `${r.ref} is completed. Reopen it to make changes.`);
  };
  const checkRoom = (siteId: number, roomId: number | null) => {
    if (roomId === null) return;
    const room = get('SELECT site_id FROM rooms WHERE id = ?', roomId);
    if (!room) throw notFound('Room');
    if (room.site_id !== siteId) throw bad('The selected Room is not in this Site');
  };
  const inspectorFields = (b: Row, cur?: Row) => {
    const userId = b.inspector_user_id !== undefined ? optInt(b.inspector_user_id, 'Inspector') : (cur?.inspector_user_id ?? null);
    if (userId !== null && !get('SELECT id FROM users WHERE id = ?', userId)) throw notFound('Inspector');
    const name = b.inspector_name !== undefined ? optStr(b.inspector_name) : (cur?.inspector_name ?? '');
    if (userId === null && !name) throw bad('Record who carried out the inspection (choose a person or type a name)');
    return { userId, name: userId !== null ? '' : name };
  };

  app.get('/api/inspections', h((req, res) => {
    const where: string[] = ['1=1'];
    const p: unknown[] = [];
    if (req.query.site_id) { where.push('i.site_id = ?'); p.push(Number(req.query.site_id)); }
    if (req.query.room_id) { where.push('i.room_id = ?'); p.push(Number(req.query.room_id)); }
    res.json(listInspections(db, where.join(' AND '), p));
  }));

  app.get('/api/inspections/:id', h((req, res) => res.json(inspectionDetail(db, idParam(req), ctx.today()))));

  app.post('/api/inspections', h((req, res) => {
    const b = req.body ?? {};
    const siteId = reqInt(b.site_id, 'Site');
    if (!get('SELECT id FROM sites WHERE id = ?', siteId)) throw notFound('Site');
    const roomId = optInt(b.room_id, 'Room');
    checkRoom(siteId, roomId);
    const insp = inspectorFields(b);
    const tmpl = get('SELECT template_code, template_version FROM checklist_questions LIMIT 1') ?? { template_code: '', template_version: '' };
    const id = Number(db.prepare(
      `INSERT INTO inspection_runs (ref, site_id, room_id, inspected_on, state, notes, inspector_user_id, inspector_name, template_code, template_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ctx.nextCode('inspection_runs', 'ref', 'PH-I'), siteId, roomId, optDate(b.inspected_on, 'Inspection date') ?? ctx.today(), optStr(b.notes),
      insp.userId, insp.name, tmpl.template_code, tmpl.template_version, ts(), ts()).lastInsertRowid);
    res.status(201).json(inspectionDetail(db, id, ctx.today()));
  }));

  app.put('/api/inspections/:id', h((req, res) => {
    const id = idParam(req);
    const cur = mustRun(id);
    mustDraft(cur);
    const b = req.body ?? {};
    const roomId = b.room_id !== undefined ? optInt(b.room_id, 'Room') : cur.room_id;
    checkRoom(cur.site_id, roomId);
    const insp = inspectorFields(b, cur);
    db.prepare('UPDATE inspection_runs SET room_id = ?, inspected_on = ?, notes = ?, inspector_user_id = ?, inspector_name = ?, updated_at = ? WHERE id = ?')
      .run(roomId, b.inspected_on !== undefined ? (optDate(b.inspected_on, 'Inspection date') ?? cur.inspected_on) : cur.inspected_on,
        b.notes !== undefined ? optStr(b.notes) : cur.notes, insp.userId, insp.name, ts(), id);
    res.json(inspectionDetail(db, id, ctx.today()));
  }));

  /** Save draft answers. response null/'' clears an answer (question returns to unanswered). */
  app.put('/api/inspections/:id/answers', h((req, res) => {
    const id = idParam(req);
    mustDraft(mustRun(id));
    const answers = req.body?.answers;
    if (!Array.isArray(answers)) throw bad('answers must be a list');
    const upsert = db.prepare(
      `INSERT INTO inspection_answers (run_id, question_code, response, notes) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, question_code) DO UPDATE SET response = excluded.response, notes = excluded.notes`,
    );
    db.transaction(() => {
      for (const a of answers as Row[]) {
        const code = String(a?.question_code ?? '');
        if (!get('SELECT code FROM checklist_questions WHERE code = ?', code)) throw bad(`Unknown question ${code}`);
        const response = a.response === null || a.response === undefined || a.response === '' ? null : String(a.response);
        const notes = optStr(a.notes);
        if (response === null) {
          const existing = get('SELECT id FROM inspection_answers WHERE run_id = ? AND question_code = ?', id, code);
          if (existing && get('SELECT id FROM actions WHERE inspection_answer_id = ?', existing.id)) {
            throw new HttpError(409, `${code} has a remedial action linked; it cannot be cleared`);
          }
          if (notes) throw bad(`${code}: choose a response before adding notes`);
          db.prepare('DELETE FROM inspection_answers WHERE run_id = ? AND question_code = ?').run(id, code);
          continue;
        }
        if (!(RESPONSES as readonly string[]).includes(response)) throw bad(`${code}: response must be one of ${RESPONSES.join(', ')}`);
        upsert.run(id, code, response, notes);
      }
      db.prepare('UPDATE inspection_runs SET updated_at = ? WHERE id = ?').run(ts(), id);
    })();
    res.json(inspectionDetail(db, id, ctx.today()));
  }));

  app.post('/api/inspections/:id/complete', h((req, res) => {
    const id = idParam(req);
    const cur = mustRun(id);
    mustDraft(cur);
    const d = inspectionDetail(db, id, ctx.today());
    if (d.unanswered.length) {
      throw bad(`${d.unanswered.length} question(s) still unanswered: ${d.unanswered.join(', ')}. Use "Not checked" for anything you could not inspect.`);
    }
    db.prepare("UPDATE inspection_runs SET state = 'complete', completed_at = ?, updated_at = ? WHERE id = ?").run(ts(), ts(), id);
    res.json(inspectionDetail(db, id, ctx.today()));
  }));

  app.post('/api/inspections/:id/reopen', h((req, res) => {
    const id = idParam(req);
    mustRun(id);
    db.prepare("UPDATE inspection_runs SET state = 'draft', completed_at = NULL, updated_at = ? WHERE id = ?").run(ts(), id);
    res.json(inspectionDetail(db, id, ctx.today()));
  }));

  app.delete('/api/inspections/:id', h((req, res) => {
    const id = idParam(req);
    mustDraft(mustRun(id));
    if (get('SELECT id FROM actions WHERE inspection_run_id = ?', id)) throw new HttpError(409, 'This draft has remedial actions; it cannot be deleted');
    db.transaction(() => {
      db.prepare("DELETE FROM document_links WHERE entity_kind = 'inspection' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM inspection_runs WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  }));

  /** Completed inspection results: one row per question. Optional ids restrict to the caller's filtered list. */
  app.post('/api/export/inspections', h((req, res) => {
    const ids: number[] | null = Array.isArray(req.body?.ids) ? req.body.ids.map((x: unknown) => reqInt(x, 'id')) : null;
    const runs = listInspections(db, "i.state = 'complete'").filter((r) => !ids || ids.includes(r.id));
    const rows: Row[] = [];
    const answers = db.prepare(
      `SELECT q.code, q.group_name, q.question, a.response, a.notes, a.id AS answer_id FROM checklist_questions q
       LEFT JOIN inspection_answers a ON a.question_code = q.code AND a.run_id = ? ORDER BY q.sort_order`,
    );
    const actionRefs = db.prepare('SELECT GROUP_CONCAT(ref, \' \') AS refs FROM actions WHERE inspection_answer_id = ?');
    for (const r of runs) {
      for (const a of answers.all(r.id) as Row[]) {
        rows.push({ ...a, run: r, action_refs: a.answer_id ? (actionRefs.get(a.answer_id) as Row).refs : '' });
      }
    }
    sendCsv(res, 'inspection-results.csv', toCsv(rows, [
      { header: 'Inspection', value: (x) => x.run.ref },
      { header: 'Inspected on', value: (x) => x.run.inspected_on },
      { header: 'Completed at', value: (x) => x.run.completed_at },
      { header: 'Inspector', value: (x) => x.run.inspector },
      { header: 'Area', value: (x) => x.run.area_code },
      { header: 'Site', value: (x) => `${x.run.site_code} ${x.run.site_name}` },
      { header: 'Room', value: (x) => (x.run.room_code ? `${x.run.room_code} ${x.run.room_name}` : 'Whole site') },
      { header: 'Question code', value: (x) => x.code },
      { header: 'Category', value: (x) => x.group_name },
      { header: 'Question', value: (x) => x.question },
      { header: 'Response', value: (x) => x.response },
      { header: 'Notes', value: (x) => x.notes },
      { header: 'Remedial actions', value: (x) => x.action_refs },
    ]));
  }));
}
