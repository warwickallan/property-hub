// Manual recalculation: the ONLY code path that writes status snapshots and reminder candidates.
// Invoked exclusively by POST /api/recalculate. No timers, cron or background work.
import type { DB } from './db.js';
import { getSetting, parseThresholds, setSetting } from './db.js';
import { evaluateActivity, reminderThreshold, type Applicability, type EvidenceInput, type Status } from './compliance.js';
import { londonToday } from './dates.js';
import { buildReminderText, messageKey } from './reminders.js';

interface ActRow {
  id: number;
  ref: string;
  location_level: string;
  last_done_on: string | null;
  next_due_on: string | null;
  expires_on: string | null;
  interval_months: number | null;
  applicability: Applicability;
  na_reason: string;
  type_name: string;
  type_interval: number | null;
  warning_days: number;
  evidence_required: number;
  owner_user_id: number | null;
  owner_name: string | null;
  owner_email: string | null;
  owner_active: number | null;
  area_code: string | null;
  site_code: string | null;
  room_code: string | null;
}

/** Shared SQL resolving any activity's Area/Site/Room breadcrumb regardless of level. */
export const ACTIVITY_LOCATION_JOINS = `
  LEFT JOIN rooms r ON r.id = a.room_id
  LEFT JOIN sites s ON s.id = COALESCE(a.site_id, r.site_id)
  LEFT JOIN areas ar ON ar.id = COALESCE(a.area_id, s.area_id)`;

export function evidenceFor(db: DB, activityId: number): EvidenceInput | null {
  const docs = db
    .prepare(
      `SELECT d.verified_by_operator AS v, d.valid_until AS vu FROM document_links l
       JOIN documents d ON d.id = l.document_id WHERE l.entity_kind = 'activity' AND l.entity_id = ?`,
    )
    .all(activityId) as { v: number; vu: string | null }[];
  if (!docs.length) return null;
  const verified = docs.filter((d) => d.v);
  if (!verified.length) return { verified: false, validUntil: null };
  const dates = verified.map((d) => d.vu).filter((d): d is string => !!d).sort();
  return { verified: true, validUntil: dates.length ? dates[dates.length - 1] : null };
}

export function recalculate(db: DB, now: Date) {
  const today = londonToday(now);
  const thresholds = parseThresholds(getSetting(db, 'reminder_thresholds'));
  const config = { as_of_date: today, reminder_thresholds: thresholds, default_warning_days: Number(getSetting(db, 'warning_days')) };

  return db.transaction(() => {
    const runId = Number(
      db.prepare('INSERT INTO recalculation_runs (created_at, as_of_date, totals_json, config_json) VALUES (?, ?, ?, ?)')
        .run(now.toISOString(), today, '{}', JSON.stringify(config)).lastInsertRowid,
    );
    const rows = db
      .prepare(
        `SELECT a.id, a.ref, a.location_level, a.last_done_on, a.next_due_on, a.expires_on, a.interval_months, a.applicability, a.na_reason,
                t.name AS type_name, t.suggested_interval_months AS type_interval, t.warning_days, t.evidence_required,
                a.owner_user_id, u.name AS owner_name, u.email AS owner_email, u.active AS owner_active,
                ar.code AS area_code, s.code AS site_code, r.code AS room_code
         FROM compliance_activities a
         JOIN compliance_types t ON t.id = a.type_id
         LEFT JOIN users u ON u.id = a.owner_user_id
         ${ACTIVITY_LOCATION_JOINS}
         WHERE a.archived_at IS NULL ORDER BY a.id`,
      )
      .all() as ActRow[];

    const critical = db.prepare(
      `SELECT COUNT(*) AS n FROM actions WHERE activity_id = ? AND priority = 'Critical' AND state <> 'Done'`,
    );
    const snap = db.prepare(
      'INSERT INTO activity_status_snapshots (run_id, activity_id, status, days_to_due, due_on, reason) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const cand = db.prepare(
      `INSERT INTO reminder_candidates (run_id, activity_id, user_id, recipient_name, recipient_email, threshold, due_on, days_to_due,
         message_key, subject, draft_text, selected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );

    const totals: Record<Status, number> & { total: number; reminders: number } = { green: 0, amber: 0, red: 0, grey: 0, na: 0, total: 0, reminders: 0 };
    for (const a of rows) {
      const result = evaluateActivity(
        {
          applicability: a.applicability,
          naReason: a.na_reason,
          lastDoneOn: a.last_done_on,
          nextDueOn: a.next_due_on,
          expiresOn: a.expires_on,
          intervalMonths: a.interval_months ?? a.type_interval,
          evidenceRequired: !!a.evidence_required,
          evidence: evidenceFor(db, a.id),
          openCriticalActions: (critical.get(a.id) as { n: number }).n,
          warningDays: a.warning_days,
        },
        today,
      );
      snap.run(runId, a.id, result.status, result.daysToDue, result.dueOn, result.reason);
      totals[result.status]++;
      totals.total++;

      if (result.status === 'na' || result.dueOn === null) continue;
      const threshold = reminderThreshold(result.daysToDue, thresholds);
      if (!threshold) continue;
      const hasRecipient = a.owner_user_id && a.owner_active && a.owner_email;
      const name = hasRecipient ? (a.owner_name ?? '') : '';
      const email = hasRecipient ? (a.owner_email ?? '') : '';
      const loc = [a.area_code, a.site_code, a.room_code].filter(Boolean).join(' / ');
      const text = buildReminderText({
        activityRef: a.ref, typeName: a.type_name, locationCodes: loc, dueOn: result.dueOn, daysToDue: result.daysToDue!, recipientName: name,
      });
      cand.run(runId, a.id, hasRecipient ? a.owner_user_id : null, name, email, threshold, result.dueOn, result.daysToDue,
        messageKey(a.id, result.dueOn, threshold, email), text.subject, text.body);
      totals.reminders++;
    }

    db.prepare('UPDATE recalculation_runs SET totals_json = ? WHERE id = ?').run(JSON.stringify(totals), runId);
    setSetting(db, 'recalculation_pending', 'false');
    return { runId, asOfDate: today, createdAt: now.toISOString(), totals };
  })();
}

export function latestRun(db: DB) {
  return db.prepare('SELECT * FROM recalculation_runs ORDER BY id DESC LIMIT 1').get() as
    | { id: number; created_at: string; as_of_date: string; totals_json: string; config_json: string }
    | undefined;
}
