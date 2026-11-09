// Pure, deterministic compliance status rules for a Compliance Activity.
// No I/O, no clock: `today` (Europe/London calendar date) is passed in.
import { addMonths, daysBetween, minDate } from './dates.js';

export type Status = 'green' | 'amber' | 'red' | 'grey' | 'na';
export type Applicability = 'required' | 'not_applicable' | 'unknown';

export interface EvidenceInput {
  /** At least one linked document has been ticked Reviewed/Verified by the operator. */
  verified: boolean;
  /** Latest valid-until among verified documents (null = none recorded). */
  validUntil: string | null;
}

export interface ActivityInput {
  applicability: Applicability;
  naReason: string;
  lastDoneOn: string | null;
  nextDueOn: string | null;
  expiresOn: string | null;
  intervalMonths: number | null;
  evidenceRequired: boolean;
  /** Evidence documents linked directly to the activity, or null when none are linked. */
  evidence: EvidenceInput | null;
  openCriticalActions: number;
  warningDays: number;
  /** Latest effective compliance check for the current cycle, if one was recorded. */
  latestCheck?: { ref: string; performedOn: string; outcome: string } | null;
}

export interface ActivityResult {
  status: Status;
  daysToDue: number | null;
  dueOn: string | null;
  reason: string;
}

export const STATUS_LABEL: Record<Status, string> = {
  green: 'Up to date',
  amber: 'Due soon',
  red: 'Overdue / at risk',
  grey: 'Unknown / missing',
  na: 'Not applicable',
};

/**
 * Precedence (most serious first) — v0.3 workflow D:
 *  1. Applicability unknown -> grey; N/A -> na (excluded from compliance rate).
 *  2. Open Critical action linked to the activity -> red.
 *  2b. Latest recorded compliance check for the current cycle was Unsatisfactory -> red.
 *  3. No usable due date -> grey.
 *  4. Effective due date (earliest of next due [or last done + interval] / expiry /
 *     verified evidence valid-until) before today -> red.
 *     Due today is NOT overdue; overdue begins the following calendar day.
 *  5. Evidence required but missing or not operator-verified -> grey
 *     ("missing required verified evidence => unknown if otherwise not red").
 *  6. Within warning window (0..warningDays inclusive) -> amber.
 *  7. Otherwise green.
 * Uploading a file alone can never produce green: it must be explicitly verified.
 * The due date is still reported for grey items so reminders are never hidden.
 */
export function evaluateActivity(input: ActivityInput, today: string): ActivityResult {
  if (input.applicability === 'unknown') {
    return { status: 'grey', daysToDue: null, dueOn: null, reason: 'Applicability not decided' };
  }
  if (input.applicability === 'not_applicable') {
    return {
      status: 'na',
      daysToDue: null,
      dueOn: null,
      reason: `Not applicable: ${input.naReason?.trim() || '(no reason recorded)'}`,
    };
  }

  const fromSchedule =
    input.nextDueOn ??
    (input.lastDoneOn && input.intervalMonths ? addMonths(input.lastDoneOn, input.intervalMonths) : null);
  const evidenceExpiry = input.evidence?.verified ? input.evidence.validUntil : null;
  const due = minDate(fromSchedule, input.expiresOn, evidenceExpiry);
  const days = due ? daysBetween(today, due) : null;
  const dueIsExpiry = !!due && due !== fromSchedule;

  if (input.openCriticalActions > 0) {
    const n = input.openCriticalActions;
    return { status: 'red', daysToDue: days, dueOn: due, reason: `Critical open action${n > 1 ? `s (${n})` : ''} recorded` };
  }
  if (input.latestCheck?.outcome === 'Unsatisfactory') {
    const d = input.latestCheck.performedOn.split('-').reverse().join('/');
    return { status: 'red', daysToDue: days, dueOn: due, reason: `Latest check ${input.latestCheck.ref} (${d}) was unsatisfactory` };
  }
  if (due === null || days === null) {
    return { status: 'grey', daysToDue: null, dueOn: null, reason: 'No next due date or last-done date + interval recorded' };
  }
  if (days < 0) {
    const n = -days;
    return { status: 'red', daysToDue: days, dueOn: due, reason: `${dueIsExpiry ? 'Expired' : 'Overdue'} by ${n} day${n === 1 ? '' : 's'}` };
  }

  const dueText = days === 0 ? 'due today' : `due in ${days} day${days === 1 ? '' : 's'}`;
  if (input.evidenceRequired && !input.evidence?.verified) {
    const what = input.evidence ? 'Evidence not reviewed/verified' : 'Required evidence missing for the current cycle';
    return { status: 'grey', daysToDue: days, dueOn: due, reason: `${what} (${dueText})` };
  }
  if (days <= input.warningDays) {
    return { status: 'amber', daysToDue: days, dueOn: due, reason: dueText.charAt(0).toUpperCase() + dueText.slice(1) };
  }
  return { status: 'green', daysToDue: days, dueOn: due, reason: `In date (${days} days remaining)` };
}

/**
 * Reminder threshold for a calculated activity, or null if no reminder is due.
 * thresholds e.g. [30, 14, 7]: picks the tightest window containing `days`.
 */
export function reminderThreshold(days: number | null, thresholds: number[]): string | null {
  if (days === null) return null;
  if (days < 0) return 'overdue';
  const sorted = [...thresholds].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const hit = sorted.find((t) => days <= t);
  return hit === undefined ? null : `${hit}d`;
}
