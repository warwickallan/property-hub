// Inspections / Visits (V2): each visit is one occurrence of work against a Compliance Activity.
// Work outcome (complete / complete with remedials) is separate from the closure lifecycle:
//   in_progress -> complete | complete_remedials | awaiting_evidence -> closed
// Closure requires: work completed, every remedial Done, and (when the Compliance Type requires it)
// at least one linked document explicitly marked Reviewed/Verified. Nothing here recalculates RAG
// status; writes only mark "Changes pending" (see app.ts middleware).
import type { Express } from 'express';
import type { DB } from './db.js';
import { optDate } from './dates.js';
import { bad, bool01, h, HttpError, idParam, notFound, optInt, optStr, reqInt, reqStr } from './http.js';
import { derivedNextDue, effectiveInterval, logScheduleChange, type ScheduleState } from './schedule.js';
import { toCsv, sendCsv } from './csv.js';

type Row = Record<string, any>;
export const RESPONSES = ['Pass', 'Issue', 'Not applicable', 'Not checked'] as const;
export const OUTCOMES = ['complete', 'complete_remedials'] as const;
export const VISIT_STATUS_LABEL: Record<string, string> = {
  in_progress: 'Scheduled / In Progress',
  complete: 'Inspection Complete',
  complete_remedials: 'Inspection Complete with Remedials',
  awaiting_evidence: 'Awaiting Evidence',
  closed: 'Closed',
};
export const OUTCOME_LABEL: Record<string, string> = { complete: 'Inspection Complete', complete_remedials: 'Inspection Complete with Remedials' };

export interface Ctx {
  db: DB;
  ts: () => string;
  today: () => string;
  nextCode: (table: string, col: string, prefix: string) => string;
}

export interface SnapshotItem { code: string; section: string; question: string; sort_order: number; mandatory: number }

const VISIT_SELECT = `
  SELECT v.*, COALESCE(u.name, NULLIF(v.provider_name, '')) AS inspector, u.name AS inspector_user_name,
         a.ref AS activity_ref, a.name AS activity_name, a.location_level, a.owner_user_id, own.name AS owner_name,
         t.id AS type_id, t.code AS type_code, t.name AS type_name, COALESCE(t.evidence_required, 0) AS evidence_required,
         s.id AS site_id, s.code AS site_code, s.name AS site_name, s.area_id AS area_id, ar.code AS area_code, ar.name AS area_name,
         r.code AS room_code, r.name AS room_name,
         (SELECT COUNT(*) FROM visit_answers x WHERE x.visit_id = v.id) AS answered,
         (SELECT COUNT(*) FROM visit_answers x WHERE x.visit_id = v.id AND x.response = 'Issue') AS issues,
         (SELECT COUNT(*) FROM actions x WHERE x.visit_id = v.id) AS remedial_count,
         (SELECT COUNT(*) FROM actions x WHERE x.visit_id = v.id AND x.state <> 'Done') AS open_remedials,
         (SELECT COUNT(*) FROM document_links l WHERE l.entity_kind = 'inspection' AND l.entity_id = v.id) AS doc_count,
         (SELECT COUNT(*) FROM document_links l JOIN documents d ON d.id = l.document_id
            WHERE l.entity_kind = 'inspection' AND l.entity_id = v.id AND d.verified_by_operator = 1) AS verified_doc_count
  FROM visits v
  LEFT JOIN compliance_activities a ON a.id = v.activity_id
  LEFT JOIN compliance_types t ON t.id = a.type_id
  LEFT JOIN rooms r ON r.id = COALESCE(v.room_id, a.room_id)
  LEFT JOIN sites s ON s.id = COALESCE(v.site_id, a.site_id, r.site_id)
  LEFT JOIN areas ar ON ar.id = COALESCE(s.area_id, a.area_id)
  LEFT JOIN users u ON u.id = v.inspector_user_id
  LEFT JOIN users own ON own.id = a.owner_user_id`;

const decorate = (v: Row): Row => {
  const items: SnapshotItem[] = JSON.parse(v.checklist_snapshot || '[]');
  const mandatory = items.filter((i) => i.mandatory).length;
  return {
    ...v,
    checklist_snapshot: undefined,
    question_count: items.length,
    mandatory_count: mandatory,
    status_label: VISIT_STATUS_LABEL[v.status],
    outcome_label: v.outcome ? OUTCOME_LABEL[v.outcome] : null,
    evidence_ok: !v.evidence_required || v.verified_doc_count > 0,
  };
};

export function listVisits(db: DB, where = '1=1', params: unknown[] = []): Row[] {
  return (db.prepare(`${VISIT_SELECT} WHERE ${where} ORDER BY COALESCE(v.performed_on, v.created_at) DESC, v.id DESC`).all(...params) as Row[]).map(decorate);
}

/** What still prevents a visit from being Closed (empty = closable). */
export function closureBlockers(db: DB, visitId: number): { code: string; message: string; items?: Row[] }[] {
  const v = listVisits(db, 'v.id = ?', [visitId])[0];
  if (!v) return [{ code: 'missing', message: 'Visit not found' }];
  const out: { code: string; message: string; items?: Row[] }[] = [];
  if (!v.completed_at) out.push({ code: 'not_complete', message: 'The inspection has not been marked complete' });
  const open = db.prepare("SELECT id, ref, title, priority, state FROM actions WHERE visit_id = ? AND state <> 'Done' ORDER BY id").all(visitId) as Row[];
  if (open.length) out.push({ code: 'remedials', message: `${open.length} remedial(s) not Done`, items: open });
  if (v.evidence_required && !v.verified_doc_count) {
    out.push({
      code: 'evidence',
      message: v.doc_count ? 'Required evidence is linked but not yet marked Reviewed/Verified' : `${v.type_code} requires evidence: link the certificate/document and mark it Reviewed/Verified`,
    });
  }
  return out;
}

export function addEvent(db: DB, visitId: number, at: string, event: string, detail = '', reason = '') {
  db.prepare('INSERT INTO visit_events (visit_id, at, event, detail, reason) VALUES (?, ?, ?, ?, ?)').run(visitId, at, event, detail, reason);
}

/**
 * Re-derive a visit's lifecycle status. When the trigger is a remedial and the final remedial has just been
 * resolved, the visit auto-closes if every closure condition is met, otherwise it moves to Awaiting Evidence.
 */
export function syncVisit(db: DB, visitId: number, at: string, trigger: 'remedial' | 'evidence' | 'other' = 'other'): string {
  const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId) as Row | undefined;
  if (!v) return 'missing';
  if (v.closed_at || !v.completed_at) return v.status;
  const blockers = closureBlockers(db, visitId);
  const remedialsOpen = blockers.some((b) => b.code === 'remedials');
  const evidenceMissing = blockers.some((b) => b.code === 'evidence');
  let status = remedialsOpen ? 'complete_remedials' : evidenceMissing ? 'awaiting_evidence' : 'complete';
  const hadRemedials = (db.prepare('SELECT COUNT(*) AS n FROM actions WHERE visit_id = ?').get(visitId) as { n: number }).n > 0;
  if (trigger === 'remedial' && v.status === 'complete_remedials' && hadRemedials && !remedialsOpen && !evidenceMissing) {
    db.prepare("UPDATE visits SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(at, at, visitId);
    addEvent(db, visitId, at, 'auto_closed', 'Final remedial resolved and all closure conditions met: inspection closed automatically');
    return 'closed';
  }
  if (status !== v.status) {
    db.prepare('UPDATE visits SET status = ?, updated_at = ? WHERE id = ?').run(status, at, visitId);
    if (status === 'awaiting_evidence') addEvent(db, visitId, at, 'awaiting_evidence', 'Remedials resolved; waiting for required evidence to be linked and verified');
  }
  return status;
}

export function registerVisits(app: Express, ctx: Ctx) {
  const { db, ts } = ctx;
  const get = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const mustVisit = (id: number) => {
    const v = get('SELECT * FROM visits WHERE id = ?', id);
    if (!v) throw notFound('Inspection / visit');
    return v;
  };
  const activityRow = (id: number) => {
    const a = get(`SELECT a.*, t.suggested_interval_months AS type_interval, t.code AS type_code, t.evidence_required FROM compliance_activities a
      JOIN compliance_types t ON t.id = a.type_id WHERE a.id = ?`, id);
    if (!a) throw notFound('Compliance activity');
    return a;
  };
  const schedState = (a: Row): ScheduleState => ({ last_done_on: a.last_done_on, next_due_on: a.next_due_on, next_due_override: a.next_due_override, next_due_override_reason: a.next_due_override_reason });

  const detail = (id: number) => {
    const v = listVisits(db, 'v.id = ?', [id])[0];
    if (!v) throw notFound('Inspection / visit');
    const raw = mustVisit(id);
    const items: SnapshotItem[] = JSON.parse(raw.checklist_snapshot || '[]');
    const answers = new Map((db.prepare('SELECT * FROM visit_answers WHERE visit_id = ?').all(id) as Row[]).map((a) => [a.item_code, a]));
    const remedials = db.prepare(`SELECT x.*, u.name AS owner_name, e.asset_code AS equipment_code, rm.code AS room_code, rm.name AS room_name
      FROM actions x LEFT JOIN users u ON u.id = x.owner_user_id LEFT JOIN equipment e ON e.id = x.equipment_id LEFT JOIN rooms rm ON rm.id = x.room_id
      WHERE x.visit_id = ? ORDER BY x.id`).all(id) as Row[];
    const questions = items.map((q) => ({
      ...q, response: answers.get(q.code)?.response ?? null, notes: answers.get(q.code)?.notes ?? '',
      remedials: remedials.filter((x) => x.question_code === q.code).map((x) => ({ id: x.id, ref: x.ref, priority: x.priority, state: x.state })),
    }));
    const sections: string[] = [];
    for (const q of items) if (!sections.includes(q.section)) sections.push(q.section);
    const today = ctx.today();
    return {
      ...v,
      sections,
      questions,
      unanswered_mandatory: questions.filter((q) => q.mandatory && !q.response).map((q) => q.code),
      unanswered: questions.filter((q) => !q.response).map((q) => q.code),
      remedials: remedials.map((x) => ({ ...x, overdue: x.state !== 'Done' && !!x.due_on && x.due_on < today })),
      blockers: closureBlockers(db, id),
      events: db.prepare('SELECT * FROM visit_events WHERE visit_id = ? ORDER BY at DESC, id DESC').all(id),
      proposed_next_due: v.activity_id && raw.performed_on
        ? derivedNextDue(raw.performed_on, effectiveInterval(activityRow(v.activity_id).interval_months, activityRow(v.activity_id).type_interval)) : null,
      interval_months: v.activity_id ? effectiveInterval(activityRow(v.activity_id).interval_months, activityRow(v.activity_id).type_interval) : null,
    };
  };
  const mustInProgress = (v: Row) => {
    if (v.status !== 'in_progress') throw new HttpError(409, `${v.ref} is ${VISIT_STATUS_LABEL[v.status]}. Reopen the work to change the checklist or visit details.`);
  };
  const inspectorOf = (b: Row, cur?: Row) => {
    const id = b.inspector_user_id !== undefined ? optInt(b.inspector_user_id, 'Inspector') : (cur?.inspector_user_id ?? null);
    if (id !== null && !get('SELECT id FROM users WHERE id = ?', id)) throw notFound('Inspector');
    return id;
  };

  /** Freeze the activity's current checklist into the visit (questions + version) so later edits never change history. */
  const snapshotFor = (a: Row) => {
    if (!a.checklist_template_id) return { template_id: null, version: null, name: '', snapshot: '[]' };
    const t = get('SELECT * FROM checklist_templates WHERE id = ?', a.checklist_template_id)!;
    if (!t.active) throw bad(`Checklist "${t.name}" is archived. Choose an active checklist on ${a.ref} first (Admin › Compliance Activities).`);
    const items = db.prepare('SELECT code, section, question, sort_order, mandatory FROM checklist_items WHERE template_id = ? AND active = 1 ORDER BY sort_order, id')
      .all(t.id) as SnapshotItem[];
    return { template_id: t.id, version: t.version, name: t.name, snapshot: JSON.stringify(items) };
  };

  app.get('/api/visits', h((_req, res) => res.json(listVisits(db))));
  app.get('/api/visits/:id', h((req, res) => res.json(detail(idParam(req)))));

  app.post('/api/visits', h((req, res) => {
    const b = req.body ?? {};
    const a = activityRow(reqInt(b.activity_id, 'Compliance activity'));
    if (a.archived_at) throw bad(`${a.ref} is archived`);
    if (a.applicability === 'not_applicable') throw bad(`${a.ref} is marked Not applicable`);
    const open = get("SELECT ref FROM visits WHERE activity_id = ? AND status = 'in_progress'", a.id);
    if (open) throw new HttpError(409, `${open.ref} is already in progress for ${a.ref}. Open it instead of starting another.`);
    const snap = snapshotFor(a);
    const performed = optDate(b.performed_on, 'Visit date') ?? ctx.today();
    const site = a.site_id ?? (a.room_id ? get('SELECT site_id FROM rooms WHERE id = ?', a.room_id)!.site_id : null);
    const id = db.transaction(() => {
      const vid = Number(db.prepare(
        `INSERT INTO visits (ref, activity_id, site_id, room_id, performed_on, inspector_user_id, provider_name, notes, checklist_template_id, checklist_version,
           checklist_name, checklist_snapshot, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
      ).run(ctx.nextCode('visits', 'ref', 'PH-V'), a.id, site, a.room_id, performed, inspectorOf(b), optStr(b.provider_name), optStr(b.notes),
        snap.template_id, snap.version, snap.name, snap.snapshot, ts(), ts()).lastInsertRowid);
      addEvent(db, vid, ts(), 'started', snap.template_id ? `Checklist "${snap.name}" v${snap.version} (${JSON.parse(snap.snapshot).length} questions)` : 'No checklist on this activity');
      return vid;
    })();
    res.status(201).json(detail(id));
  }));

  app.put('/api/visits/:id', h((req, res) => {
    const id = idParam(req);
    const v = mustVisit(id);
    mustInProgress(v);
    const b = req.body ?? {};
    const performed = b.performed_on !== undefined ? optDate(b.performed_on, 'Visit date') : v.performed_on;
    db.prepare('UPDATE visits SET performed_on = ?, inspector_user_id = ?, provider_name = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(performed, inspectorOf(b, v), b.provider_name !== undefined ? optStr(b.provider_name) : v.provider_name,
        b.notes !== undefined ? optStr(b.notes) : v.notes, ts(), id);
    res.json(detail(id));
  }));

  app.put('/api/visits/:id/answers', h((req, res) => {
    const id = idParam(req);
    const v = mustVisit(id);
    mustInProgress(v);
    const codes = new Set((JSON.parse(v.checklist_snapshot || '[]') as SnapshotItem[]).map((q) => q.code));
    const answers = req.body?.answers;
    if (!Array.isArray(answers)) throw bad('answers must be a list');
    const upsert = db.prepare(`INSERT INTO visit_answers (visit_id, item_code, response, notes) VALUES (?, ?, ?, ?)
      ON CONFLICT(visit_id, item_code) DO UPDATE SET response = excluded.response, notes = excluded.notes`);
    db.transaction(() => {
      for (const a of answers as Row[]) {
        const code = String(a?.item_code ?? a?.question_code ?? '');
        if (!codes.has(code)) throw bad(`Question ${code} is not on this visit's checklist`);
        const response = a.response === null || a.response === undefined || a.response === '' ? null : String(a.response);
        const notes = optStr(a.notes);
        if (response === null) {
          if (get('SELECT id FROM actions WHERE visit_id = ? AND question_code = ?', id, code)) throw new HttpError(409, `${code} has a remedial linked; it cannot be cleared`);
          if (notes) throw bad(`${code}: choose a response before adding notes`);
          db.prepare('DELETE FROM visit_answers WHERE visit_id = ? AND item_code = ?').run(id, code);
          continue;
        }
        if (!(RESPONSES as readonly string[]).includes(response)) throw bad(`${code}: response must be one of ${RESPONSES.join(', ')}`);
        upsert.run(id, code, response, notes);
      }
      db.prepare('UPDATE visits SET updated_at = ? WHERE id = ?').run(ts(), id);
    })();
    res.json(detail(id));
  }));

  /** Record the work as performed. Updates the activity schedule; does NOT make the activity compliant. */
  app.post('/api/visits/:id/complete', h((req, res) => {
    const id = idParam(req);
    const v = mustVisit(id);
    mustInProgress(v);
    if (!v.activity_id) throw bad(`${v.ref} is not linked to a Compliance Activity. Link it first (it was upgraded from an older version).`);
    const a = activityRow(v.activity_id);
    const b = req.body ?? {};
    const outcome = String(b.outcome ?? '');
    if (!(OUTCOMES as readonly string[]).includes(outcome)) throw bad('Choose the outcome: Inspection Complete, or Inspection Complete with Remedials');
    const performed = optDate(b.performed_on ?? v.performed_on, 'Performed on');
    if (!performed) throw bad('Enter the date the work was performed');
    if (performed > ctx.today()) throw bad('Performed date cannot be in the future');
    if (v.inspector_user_id === null && !v.provider_name) throw bad('Record who carried out the inspection (inspector or provider) before completing');
    const d = detail(id);
    if (d.unanswered_mandatory.length) throw bad(`${d.unanswered_mandatory.length} mandatory question(s) unanswered: ${d.unanswered_mandatory.join(', ')}. Use "Not checked" where something could not be inspected.`);
    const total = d.remedials.length;
    const open = d.remedials.filter((x: Row) => x.state !== 'Done').length;
    if (outcome === 'complete' && open) throw bad(`${open} remedial(s) are open: choose "Inspection Complete with Remedials"`);
    if (outcome === 'complete_remedials' && !total) throw bad('Raise at least one remedial before choosing "Inspection Complete with Remedials"');
    const interval = effectiveInterval(a.interval_months, a.type_interval);
    const override = !!bool01(b.next_due_override, 0);
    const overrideDate = override ? optDate(b.next_due_on, 'Next due override') : null;
    const reason = override ? optStr(b.override_reason) : '';
    if (override && (!overrideDate || !reason)) throw bad('An override needs both a next-due date and a reason');
    if (override && overrideDate! <= performed) throw bad('Override next-due date must be after the performed date');
    const proposed = derivedNextDue(performed, interval);
    const nextDue = override ? overrideDate : proposed;
    if (!nextDue) throw bad(`${a.ref} has no interval, so next due cannot be calculated: set an interval on the activity or type, or enter an override`);

    db.transaction(() => {
      db.prepare(`UPDATE visits SET performed_on = ?, outcome = ?, completed_at = ?, next_due_override = ?, next_due_set = ?, override_reason = ?,
        previous_last_done = ?, previous_next_due = ?, previous_override = ?, previous_override_reason = ?, previous_schedule_visit_id = ?, updated_at = ? WHERE id = ?`)
        .run(performed, outcome, ts(), override ? 1 : 0, nextDue, reason, a.last_done_on, a.next_due_on, a.next_due_override, a.next_due_override_reason,
          a.schedule_visit_id, ts(), id);
      addEvent(db, id, ts(), 'completed', `${OUTCOME_LABEL[outcome]} · performed ${performed}${total ? ` · ${open} of ${total} remedial(s) open` : ''}`);
      // Schedule moves forward only for work not older than the activity's current last inspection date.
      if (!a.last_done_on || performed >= a.last_done_on) {
        const after: ScheduleState = { last_done_on: performed, next_due_on: nextDue, next_due_override: override ? 1 : 0, next_due_override_reason: reason };
        db.prepare(`UPDATE compliance_activities SET last_done_on = ?, next_due_on = ?, next_due_override = ?, next_due_override_reason = ?, schedule_visit_id = ?, updated_at = ?
          WHERE id = ?`).run(performed, nextDue, after.next_due_override, reason, id, ts(), a.id);
        db.prepare('UPDATE visits SET schedule_applied = 1 WHERE id = ?').run(id);
        logScheduleChange(db, a.id, schedState(a), after, 'visit', ts(), id, `${v.ref} completed`);
      } else {
        addEvent(db, id, ts(), 'history_only', `Performed before the current last inspection (${a.last_done_on}); schedule not changed`);
      }
      // Derive the lifecycle (complete / complete with remedials / awaiting evidence). Never auto-closes here:
      // a visit completed without remedials is closed by the operator's Close action.
      db.prepare("UPDATE visits SET status = 'complete' WHERE id = ?").run(id);
      syncVisit(db, id, ts());
    })();
    res.json(detail(id));
  }));

  app.post('/api/visits/:id/close', h((req, res) => {
    const id = idParam(req);
    const v = mustVisit(id);
    if (v.closed_at) throw new HttpError(409, `${v.ref} is already closed`);
    const blockers = closureBlockers(db, id);
    if (blockers.length) {
      res.status(409).json({ error: `Cannot close ${v.ref}: ${blockers.map((x) => x.message).join('; ')}`, blockers });
      return;
    }
    db.transaction(() => {
      db.prepare("UPDATE visits SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(ts(), ts(), id);
      addEvent(db, id, ts(), 'closed', 'Closed by operator: work complete, remedials Done, evidence requirement met');
    })();
    res.json(detail(id));
  }));

  /**
   * Deliberate, traceable reopening.
   *  scope 'closure' (closed -> back to its completed state, closure date cleared, evidence kept);
   *  scope 'work' (completed, not closed -> In progress; schedule set by this visit is reverted).
   */
  app.post('/api/visits/:id/reopen', h((req, res) => {
    const id = idParam(req);
    const v = mustVisit(id);
    const reason = reqStr(req.body?.reason, 'Reason for reopening');
    const scope = req.body?.scope === 'work' ? 'work' : 'closure';
    db.transaction(() => {
      if (scope === 'closure') {
        if (!v.closed_at) throw new HttpError(409, `${v.ref} is not closed`);
        db.prepare("UPDATE visits SET closed_at = NULL, status = 'complete', updated_at = ? WHERE id = ?").run(ts(), id);
        addEvent(db, id, ts(), 'reopened', `Closure reopened (was closed ${v.closed_at})`, reason);
        syncVisit(db, id, ts());
      } else {
        if (v.closed_at) throw new HttpError(409, `${v.ref} is closed: reopen the closure first`);
        if (!v.completed_at) throw new HttpError(409, `${v.ref} is already in progress`);
        const a = v.activity_id ? activityRow(v.activity_id) : null;
        if (a && a.schedule_visit_id === id) {
          const restored: ScheduleState = { last_done_on: v.previous_last_done, next_due_on: v.previous_next_due, next_due_override: v.previous_override, next_due_override_reason: v.previous_override_reason };
          db.prepare(`UPDATE compliance_activities SET last_done_on = ?, next_due_on = ?, next_due_override = ?, next_due_override_reason = ?, schedule_visit_id = ?, updated_at = ?
            WHERE id = ?`).run(restored.last_done_on, restored.next_due_on, restored.next_due_override, restored.next_due_override_reason, v.previous_schedule_visit_id, ts(), a.id);
          logScheduleChange(db, a.id, schedState(a), restored, 'visit-reopen', ts(), id, `${v.ref} work reopened: ${reason}`);
        }
        db.prepare("UPDATE visits SET status = 'in_progress', outcome = NULL, completed_at = NULL, schedule_applied = 0, updated_at = ? WHERE id = ?").run(ts(), id);
        addEvent(db, id, ts(), 'work_reopened', `Work reopened (was completed ${v.completed_at}, outcome ${OUTCOME_LABEL[v.outcome] ?? v.outcome})`, reason);
      }
    })();
    res.json(detail(id));
  }));

  /** Link an upgraded (legacy) visit to a Compliance Activity after review. Does not change any schedule. */
  app.post('/api/visits/:id/link-activity', h((req, res) => {
    const id = idParam(req);
    const v = mustVisit(id);
    if (v.activity_id) throw new HttpError(409, `${v.ref} is already linked to an activity`);
    const a = activityRow(reqInt(req.body?.activity_id, 'Compliance activity'));
    const aSite = a.site_id ?? (a.room_id ? get('SELECT site_id FROM rooms WHERE id = ?', a.room_id)!.site_id : null);
    const aArea = a.area_id ?? (aSite ? get('SELECT area_id FROM sites WHERE id = ?', aSite)!.area_id : null);
    const vArea = v.site_id ? get('SELECT area_id FROM sites WHERE id = ?', v.site_id)!.area_id : null;
    if ((aSite && v.site_id && aSite !== v.site_id) || (!aSite && aArea !== vArea)) throw bad(`${a.ref} is not at this visit's location`);
    db.transaction(() => {
      db.prepare('UPDATE visits SET activity_id = ?, needs_review = 0, updated_at = ? WHERE id = ?').run(a.id, ts(), id);
      db.prepare('UPDATE actions SET activity_id = COALESCE(activity_id, ?), needs_review = 0 WHERE visit_id = ?').run(a.id, id);
      addEvent(db, id, ts(), 'linked', `Linked to ${a.ref} after review (schedule unchanged)`, optStr(req.body?.reason));
    })();
    res.json(detail(id));
  }));

  app.delete('/api/visits/:id', h((req, res) => {
    const id = idParam(req);
    const v = mustVisit(id);
    mustInProgress(v);
    if (get('SELECT id FROM actions WHERE visit_id = ?', id)) throw new HttpError(409, 'This visit has remedials; it cannot be deleted');
    if (get("SELECT id FROM document_links WHERE entity_kind = 'inspection' AND entity_id = ?", id)) throw new HttpError(409, 'This visit has documents linked; unlink them first');
    db.prepare('DELETE FROM visits WHERE id = ?').run(id);
    res.json({ ok: true });
  }));

  /** Completed visit results, one row per checklist question (or one row for a visit without a checklist). */
  app.post('/api/export/visits', h((req, res) => {
    const ids: number[] | null = Array.isArray(req.body?.ids) ? req.body.ids.map((x: unknown) => reqInt(x, 'id')) : null;
    const visits = listVisits(db, 'v.completed_at IS NOT NULL').filter((x) => !ids || ids.includes(x.id));
    const rows: Row[] = [];
    for (const v of visits) {
      const d = detail(v.id);
      const qs = d.questions.length ? d.questions : [{ code: '', section: '', question: '(no checklist)', response: '', notes: '', remedials: [] }];
      for (const q of qs) rows.push({ v, q });
    }
    sendCsv(res, 'inspection-results.csv', toCsv(rows, [
      { header: 'Visit', value: (x) => x.v.ref },
      { header: 'Activity', value: (x) => x.v.activity_ref },
      { header: 'Type', value: (x) => x.v.type_code },
      { header: 'Area', value: (x) => x.v.area_code },
      { header: 'Site', value: (x) => (x.v.site_code ? `${x.v.site_code} ${x.v.site_name}` : '') },
      { header: 'Room', value: (x) => (x.v.room_code ? `${x.v.room_code} ${x.v.room_name}` : '') },
      { header: 'Performed on', value: (x) => x.v.performed_on },
      { header: 'Inspector / provider', value: (x) => x.v.inspector },
      { header: 'Outcome', value: (x) => OUTCOME_LABEL[x.v.outcome] ?? '' },
      { header: 'Status', value: (x) => VISIT_STATUS_LABEL[x.v.status] },
      { header: 'Closed at', value: (x) => x.v.closed_at },
      { header: 'Checklist', value: (x) => (x.v.checklist_name ? `${x.v.checklist_name} v${x.v.checklist_version ?? '-'}` : '') },
      { header: 'Question code', value: (x) => x.q.code },
      { header: 'Section', value: (x) => x.q.section },
      { header: 'Question', value: (x) => x.q.question },
      { header: 'Response', value: (x) => x.q.response },
      { header: 'Notes', value: (x) => x.q.notes },
      { header: 'Remedials', value: (x) => x.q.remedials.map((r: Row) => r.ref).join(' ') },
    ]));
  }));
}
