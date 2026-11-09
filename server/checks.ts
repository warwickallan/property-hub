// Compliance inspections / checks (P1.1): the actual statutory work done against one Compliance Activity
// (e.g. a Gas Safety check). Each check is an immutable historical event. Corrections are made by a
// deliberate amendment, which records a NEW check that supersedes the original (the original is kept,
// only its superseded_by_id pointer is set). Recording or amending a check updates the activity's
// schedule and marks changes pending; it never recalculates status by itself.
import type { Express } from 'express';
import type { DB } from './db.js';
import { optDate } from './dates.js';
import { bad, bool01, h, HttpError, idParam, notFound, optInt, optStr, reqInt, reqStr } from './http.js';
import { derivedNextDue, effectiveInterval, logScheduleChange, type ScheduleState } from './schedule.js';
import type { Ctx } from './inspections.js';

type Row = Record<string, any>;
export const OUTCOMES = ['Satisfactory', 'Satisfactory with advisories', 'Unsatisfactory', 'Not completed'] as const;

const CHECK_SELECT = `
  SELECT c.*, COALESCE(u.name, NULLIF(c.provider_name, '')) AS inspector, u.name AS inspector_user_name,
         a.ref AS activity_ref, a.name AS activity_name, a.location_level, t.code AS type_code, t.name AS type_name,
         ar.id AS area_id, ar.code AS area_code, s.id AS site_id, s.code AS site_code, s.name AS site_name,
         r.id AS room_id, r.code AS room_code, r.name AS room_name,
         d.display_name AS certificate_name, d.verified_by_operator AS certificate_verified, d.valid_until AS certificate_valid_until,
         d.issued_on AS certificate_issued_on,
         am.ref AS amends_ref, sb.ref AS superseded_by_ref
  FROM compliance_checks c
  JOIN compliance_activities a ON a.id = c.activity_id
  JOIN compliance_types t ON t.id = a.type_id
  LEFT JOIN rooms r ON r.id = a.room_id
  LEFT JOIN sites s ON s.id = COALESCE(a.site_id, r.site_id)
  LEFT JOIN areas ar ON ar.id = COALESCE(a.area_id, s.area_id)
  LEFT JOIN users u ON u.id = c.inspector_user_id
  LEFT JOIN documents d ON d.id = c.certificate_document_id
  LEFT JOIN compliance_checks am ON am.id = c.amends_check_id
  LEFT JOIN compliance_checks sb ON sb.id = c.superseded_by_id`;

export function listChecks(db: DB, where = '1=1', params: unknown[] = []): Row[] {
  return db.prepare(`${CHECK_SELECT} WHERE ${where} ORDER BY c.performed_on DESC, c.id DESC`).all(...params) as Row[];
}

export function registerChecks(app: Express, ctx: Ctx) {
  const { db, ts } = ctx;
  const get = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const one = (id: number) => listChecks(db, 'c.id = ?', [id])[0];
  const activityRow = (id: number) => {
    const a = get(`SELECT a.*, t.suggested_interval_months AS type_interval FROM compliance_activities a JOIN compliance_types t ON t.id = a.type_id WHERE a.id = ?`, id);
    if (!a) throw notFound('Activity');
    return a;
  };
  const state = (a: Row): ScheduleState => ({
    last_done_on: a.last_done_on, next_due_on: a.next_due_on, next_due_override: a.next_due_override, next_due_override_reason: a.next_due_override_reason,
  });

  /** Validates check fields; returns the values to store (schedule proposal included). */
  const fields = (b: Row, act: Row, base?: Row) => {
    const pick = (k: string) => (b[k] !== undefined ? b[k] : base?.[k]);
    const performed = optDate(pick('performed_on'), 'Performed on');
    if (!performed) throw bad('Enter the date the inspection/check was performed');
    if (performed > ctx.today()) throw bad('Performed date cannot be in the future');
    const inspectorId = b.inspector_user_id !== undefined ? optInt(b.inspector_user_id, 'Inspector') : (base?.inspector_user_id ?? null);
    if (inspectorId !== null && !get('SELECT id FROM users WHERE id = ?', inspectorId)) throw notFound('Inspector');
    const provider = optStr(pick('provider_name'));
    if (inspectorId === null && !provider) throw bad('Record who carried out the check: choose a person or enter the engineer/provider');
    const outcome = String(pick('outcome') ?? '');
    if (!(OUTCOMES as readonly string[]).includes(outcome)) throw bad(`Outcome must be one of: ${OUTCOMES.join(', ')}`);
    const certId = b.certificate_document_id !== undefined ? optInt(b.certificate_document_id, 'Certificate') : (base?.certificate_document_id ?? null);
    if (certId !== null && !get('SELECT id FROM documents WHERE id = ?', certId)) throw notFound('Certificate document');
    const interval = effectiveInterval(act.interval_months, act.type_interval);
    const proposed = derivedNextDue(performed, interval);
    const override = b.next_due_override !== undefined ? !!bool01(b.next_due_override, 0) : !!base?.next_due_override;
    const overrideDate = override ? optDate(pick('next_due_on'), 'Next due override') : null;
    const overrideReason = override ? optStr(pick('override_reason')) : '';
    if (override && !overrideDate) throw bad('Enter the override next-due date');
    if (override && !overrideReason) throw bad('Give a reason for overriding the calculated next-due date');
    if (override && overrideDate! <= performed) throw bad('Override next-due date must be after the performed date');
    if (!override && !proposed && outcome !== 'Not completed') {
      throw bad('This activity has no interval, so next due cannot be calculated. Set an interval on the activity or type, or enter an override.');
    }
    return {
      performed_on: performed, inspector_user_id: inspectorId, provider_name: inspectorId === null ? provider : provider,
      outcome, notes: optStr(pick('notes')), certificate_document_id: certId, interval_months_used: interval,
      proposed_next_due: proposed, next_due_override: override ? 1 : 0, next_due_on: override ? overrideDate : proposed, override_reason: overrideReason,
    };
  };

  /** Link the certificate to the activity's evidence and apply explicit operator verification. */
  const attachCertificate = (b: Row, activityId: number, certId: number | null, performed: string) => {
    if (certId === null) return;
    db.prepare("INSERT OR IGNORE INTO document_links (document_id, entity_kind, entity_id, link_role, created_at) VALUES (?, 'activity', ?, 'certificate', ?)")
      .run(certId, activityId, ts());
    const doc = get('SELECT * FROM documents WHERE id = ?', certId)!;
    const validUntil = b.certificate_valid_until !== undefined ? optDate(b.certificate_valid_until, 'Certificate valid until') : doc.valid_until;
    const issued = b.certificate_issued_on !== undefined ? optDate(b.certificate_issued_on, 'Certificate issued on') : (doc.issued_on ?? performed);
    // Verification only ever changes on an explicit tick; uploading/linking alone never verifies.
    const verify = b.verify_certificate !== undefined ? bool01(b.verify_certificate, 0) : doc.verified_by_operator;
    db.prepare('UPDATE documents SET valid_until = ?, issued_on = ?, verified_by_operator = ?, verified_at = ? WHERE id = ?')
      .run(validUntil, issued, verify, verify ? (doc.verified_by_operator ? doc.verified_at : ts()) : null, certId);
  };

  const insertCheck = (activityId: number, f: Row, act: Row, extra: Row = {}) => {
    const ref = ctx.nextCode('compliance_checks', 'ref', 'PH-K');
    return Number(db.prepare(
      `INSERT INTO compliance_checks (ref, activity_id, performed_on, inspector_user_id, provider_name, outcome, notes, certificate_document_id,
         interval_months_used, proposed_next_due, next_due_override, next_due_on, override_reason, schedule_applied,
         previous_last_done, previous_next_due, previous_override, previous_override_reason, previous_schedule_check_id,
         amends_check_id, amendment_reason, recorded_at)
       VALUES (@ref, @activity_id, @performed_on, @inspector_user_id, @provider_name, @outcome, @notes, @certificate_document_id,
         @interval_months_used, @proposed_next_due, @next_due_override, @next_due_on, @override_reason, 0,
         @previous_last_done, @previous_next_due, @previous_override, @previous_override_reason, @previous_schedule_check_id,
         @amends_check_id, @amendment_reason, @recorded_at)`,
    ).run({
      ...f, ref, activity_id: activityId, previous_last_done: act.last_done_on, previous_next_due: act.next_due_on,
      previous_override: act.next_due_override, previous_override_reason: act.next_due_override_reason, previous_schedule_check_id: act.schedule_check_id,
      amends_check_id: null, amendment_reason: '', recorded_at: ts(), ...extra,
    }).lastInsertRowid);
  };

  const applySchedule = (act: Row, checkId: number, f: Row, source: 'check' | 'amendment', note: string) => {
    const after: ScheduleState = { last_done_on: f.performed_on, next_due_on: f.next_due_on, next_due_override: f.next_due_override, next_due_override_reason: f.override_reason };
    db.prepare(`UPDATE compliance_activities SET last_done_on = ?, next_due_on = ?, next_due_override = ?, next_due_override_reason = ?, schedule_check_id = ?, updated_at = ?
      WHERE id = ?`).run(after.last_done_on, after.next_due_on, after.next_due_override, after.next_due_override_reason, checkId, ts(), act.id);
    db.prepare('UPDATE compliance_checks SET schedule_applied = 1 WHERE id = ?').run(checkId);
    logScheduleChange(db, act.id, state(act), after, source, ts(), checkId, note);
  };

  app.get('/api/checks', h((req, res) => {
    const where: string[] = ['1=1'];
    const p: unknown[] = [];
    if (req.query.activity_id) { where.push('c.activity_id = ?'); p.push(Number(req.query.activity_id)); }
    if (req.query.current === '1') where.push('c.superseded_by_id IS NULL');
    res.json(listChecks(db, where.join(' AND '), p));
  }));
  app.get('/api/checks/:id', h((req, res) => {
    const c = one(idParam(req));
    if (!c) throw notFound('Inspection / check');
    res.json(c);
  }));

  /** Proposed next due for a performed date (same arithmetic the server applies on save). */
  app.get('/api/activities/:id/check-proposal', h((req, res) => {
    const act = activityRow(idParam(req));
    const performed = optDate(req.query.performed_on, 'Performed on');
    const interval = effectiveInterval(act.interval_months, act.type_interval);
    res.json({ interval_months: interval, proposed_next_due: performed ? derivedNextDue(performed, interval) : null });
  }));

  app.post('/api/checks', h((req, res) => {
    const b = req.body ?? {};
    const act = activityRow(reqInt(b.activity_id, 'Compliance activity'));
    if (act.archived_at) throw bad('This activity is archived');
    const f = fields(b, act);
    const id = db.transaction(() => {
      attachCertificate(b, act.id, f.certificate_document_id, f.performed_on);
      const checkId = insertCheck(act.id, f, act);
      // Only a completed check that is not older than the current schedule moves the schedule forward.
      // A retrospective (older) record is kept in history without rewriting the schedule.
      if (f.outcome !== 'Not completed' && (!act.last_done_on || f.performed_on >= act.last_done_on)) {
        applySchedule(act, checkId, f, 'check', '');
      }
      return checkId;
    })();
    res.status(201).json(one(id));
  }));

  /** Deliberate, traceable correction: creates a superseding check; the original record is preserved. */
  app.post('/api/checks/:id/amend', h((req, res) => {
    const origId = idParam(req);
    const orig = get('SELECT * FROM compliance_checks WHERE id = ?', origId);
    if (!orig) throw notFound('Inspection / check');
    if (orig.superseded_by_id) throw new HttpError(409, `This record was already amended by ${one(orig.superseded_by_id).ref}; amend the latest version instead`);
    const b = req.body ?? {};
    const reason = reqStr(b.amendment_reason, 'Amendment reason');
    const act = activityRow(orig.activity_id);
    const f = fields(b, act, orig);
    const id = db.transaction(() => {
      attachCertificate(b, act.id, f.certificate_document_id, f.performed_on);
      // If the schedule came from the record being corrected, the amendment inherits that record's
      // "schedule before" so the whole correction chain can be unwound to the pre-check state.
      const chainBefore = act.schedule_check_id === origId ? {
        previous_last_done: orig.previous_last_done, previous_next_due: orig.previous_next_due, previous_override: orig.previous_override,
        previous_override_reason: orig.previous_override_reason, previous_schedule_check_id: orig.previous_schedule_check_id,
      } : {};
      const newId = insertCheck(act.id, f, act, { amends_check_id: origId, amendment_reason: reason, ...chainBefore });
      db.prepare('UPDATE compliance_checks SET superseded_by_id = ? WHERE id = ?').run(newId, origId);
      const note = `Amends ${orig.ref}: ${reason}`;
      if (act.schedule_check_id === origId) {
        // The schedule came from the record being corrected: follow the correction.
        if (f.outcome !== 'Not completed') applySchedule(act, newId, f, 'amendment', note);
        else {
          const restored: ScheduleState = {
            last_done_on: orig.previous_last_done, next_due_on: orig.previous_next_due,
            next_due_override: orig.previous_override, next_due_override_reason: orig.previous_override_reason,
          };
          db.prepare(`UPDATE compliance_activities SET last_done_on = ?, next_due_on = ?, next_due_override = ?, next_due_override_reason = ?, schedule_check_id = ?, updated_at = ?
            WHERE id = ?`).run(restored.last_done_on, restored.next_due_on, restored.next_due_override, restored.next_due_override_reason,
            orig.previous_schedule_check_id, ts(), act.id);
          logScheduleChange(db, act.id, state(act), restored, 'amendment', ts(), newId, `${note} (schedule restored to before ${orig.ref})`);
        }
      } else if (f.outcome !== 'Not completed' && (!act.last_done_on || f.performed_on >= act.last_done_on)) {
        applySchedule(act, newId, f, 'amendment', note);
      }
      return newId;
    })();
    res.status(201).json(one(id));
  }));
}
