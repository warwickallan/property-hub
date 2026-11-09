// Single source of truth for an Activity's schedule arithmetic.
// Next due = last done + interval (calendar months, clamped at month end), unless the operator
// sets an explicit, reasoned override. The effective date is persisted on the activity
// (compliance_activities.next_due_on) and is what manual Recalculate uses.
import type { DB } from './db.js';
import { addMonths } from './dates.js';

export interface ScheduleInput {
  last_done_on: string | null;
  interval_months: number | null; // activity-specific interval
  type_interval: number | null; // compliance type default
  next_due_override: boolean;
  override_date: string | null; // only used when next_due_override
}

export function effectiveInterval(activityInterval: number | null | undefined, typeInterval: number | null | undefined): number | null {
  return activityInterval ?? typeInterval ?? null;
}

export function derivedNextDue(lastDone: string | null, interval: number | null): string | null {
  return lastDone && interval ? addMonths(lastDone, interval) : null;
}

export function effectiveNextDue(s: ScheduleInput): { next_due_on: string | null; derived: string | null } {
  const derived = derivedNextDue(s.last_done_on, effectiveInterval(s.interval_months, s.type_interval));
  return { next_due_on: s.next_due_override ? s.override_date : derived, derived };
}

export type ScheduleSource = 'edit' | 'check' | 'amendment' | 'type-interval' | 'migration';

export interface ScheduleState {
  last_done_on: string | null;
  next_due_on: string | null;
  next_due_override: number;
  next_due_override_reason: string;
}

/** Writes a traceable schedule change entry when anything actually changed. */
export function logScheduleChange(db: DB, activityId: number, before: ScheduleState, after: ScheduleState, source: ScheduleSource, at: string, checkId: number | null = null, note = '') {
  const same = before.last_done_on === after.last_done_on && before.next_due_on === after.next_due_on &&
    !!before.next_due_override === !!after.next_due_override && (before.next_due_override_reason ?? '') === (after.next_due_override_reason ?? '');
  // Recorded checks/amendments always leave a trace (they set the schedule even when dates coincide).
  if (same && source !== 'check' && source !== 'amendment') return;
  db.prepare(
    `INSERT INTO activity_schedule_log (activity_id, changed_at, source, check_id, old_last_done, new_last_done, old_next_due, new_next_due, old_override, new_override, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(activityId, at, source, checkId, before.last_done_on, after.last_done_on, before.next_due_on, after.next_due_on,
    before.next_due_override ? 1 : 0, after.next_due_override ? 1 : 0, note);
}

/** Re-derive persisted next-due for non-override activities that follow the type default interval. */
export function rederiveForType(db: DB, typeId: number, at: string) {
  const type = db.prepare('SELECT suggested_interval_months AS m FROM compliance_types WHERE id = ?').get(typeId) as { m: number | null };
  const rows = db.prepare('SELECT * FROM compliance_activities WHERE type_id = ? AND next_due_override = 0 AND interval_months IS NULL').all(typeId) as any[];
  const upd = db.prepare('UPDATE compliance_activities SET next_due_on = ?, updated_at = ? WHERE id = ?');
  for (const a of rows) {
    const next = derivedNextDue(a.last_done_on, type.m);
    if (next === a.next_due_on) continue;
    upd.run(next, at, a.id);
    logScheduleChange(db, a.id, a, { ...a, next_due_on: next }, 'type-interval', at, null, `Type default interval now ${type.m ?? 'none'} months`);
  }
}
