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

export interface VisitInput {
  ref: string;
  /** Visit lifecycle: complete | complete_remedials | awaiting_evidence | closed */
  status: string;
  openRemedials: number;
  closedOn: string | null;
}

export interface ActivityInput {
  applicability: Applicability;
  naReason: string;
  lastDoneOn: string | null;
  nextDueOn: string | null;
  expiresOn: string | null;
  intervalMonths: number | null;
  evidenceRequired: boolean;
  /** Current-cycle evidence (documents of the visit that set the schedule, or activity documents for legacy schedules). */
  evidence: EvidenceInput | null;
  openCriticalActions: number;
  warningDays: number;
  /** The completed visit that set the current schedule (V2). Null for schedules entered manually or before v0.5. */
  visit?: VisitInput | null;
  /** A visit currently Scheduled / In Progress (work not yet recorded), if any. */
  inProgressRef?: string | null;
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

const uk = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/**
 * Activity (obligation) status. Distinct from a visit's status, but uses the visit that set the
 * current schedule as the evidence of compliance. Precedence (most serious first):
 *  1. Applicability unknown -> grey; N/A -> na.
 *  2. Open Critical remedial linked to the activity -> red.
 *  3. No usable due date -> grey.
 *  4. Effective due date (next due / expiry / verified evidence valid-until) before today -> red.
 *     Due today is NOT overdue; overdue begins the following calendar day. No visit state can
 *     override an expired obligation.
 *  5. The visit that set the schedule is not Closed:
 *       complete with remedials outstanding -> amber; awaiting required evidence -> grey;
 *       complete but not yet closed -> amber.
 *  6. Schedules without a visit: evidence required but missing / unverified -> grey.
 *  7. Within warning window (0..warningDays inclusive) -> amber.
 *  8. Otherwise green ("Compliant / verified" when backed by a closed visit).
 * Uploading a file alone never produces green: it must be explicitly verified.
 */
export function evaluateActivity(input: ActivityInput, today: string): ActivityResult {
  if (input.applicability === 'unknown') {
    return { status: 'grey', daysToDue: null, dueOn: null, reason: 'Applicability not decided' };
  }
  if (input.applicability === 'not_applicable') {
    return { status: 'na', daysToDue: null, dueOn: null, reason: `Not applicable: ${input.naReason?.trim() || '(no reason recorded)'}` };
  }

  const fromSchedule =
    input.nextDueOn ??
    (input.lastDoneOn && input.intervalMonths ? addMonths(input.lastDoneOn, input.intervalMonths) : null);
  const evidenceExpiry = input.evidence?.verified ? input.evidence.validUntil : null;
  const due = minDate(fromSchedule, input.expiresOn, evidenceExpiry);
  const days = due ? daysBetween(today, due) : null;
  const dueIsExpiry = !!due && due !== fromSchedule;
  const pending = input.inProgressRef ? ` (visit ${input.inProgressRef} in progress, not yet completed)` : '';

  if (input.openCriticalActions > 0) {
    const n = input.openCriticalActions;
    return { status: 'red', daysToDue: days, dueOn: due, reason: `Critical open remedial${n > 1 ? `s (${n})` : ''} recorded` };
  }
  if (due === null || days === null) {
    return { status: 'grey', daysToDue: null, dueOn: null, reason: `No schedule yet: record an inspection or set the last inspection date${pending}` };
  }
  if (days < 0) {
    const n = -days;
    return { status: 'red', daysToDue: days, dueOn: due, reason: `${dueIsExpiry ? 'Expired' : 'Overdue'} by ${n} day${n === 1 ? '' : 's'}${pending}` };
  }

  const dueText = days === 0 ? 'due today' : `due in ${days} day${days === 1 ? '' : 's'}`;
  const v = input.visit;
  if (v && v.status !== 'closed') {
    if (v.status === 'complete_remedials') {
      return { status: 'amber', daysToDue: days, dueOn: due, reason: `Inspection ${v.ref} complete with remedials outstanding (${v.openRemedials})` };
    }
    if (v.status === 'awaiting_evidence') {
      return { status: 'grey', daysToDue: days, dueOn: due, reason: `Awaiting required evidence for inspection ${v.ref}` };
    }
    return { status: 'amber', daysToDue: days, dueOn: due, reason: `Inspection ${v.ref} complete, not yet closed` };
  }
  if (!v && input.evidenceRequired && !input.evidence?.verified) {
    const what = input.evidence ? 'Evidence not reviewed/verified' : 'Required evidence missing for the current cycle';
    return { status: 'grey', daysToDue: days, dueOn: due, reason: `${what} (${dueText})${pending}` };
  }
  if (days <= input.warningDays) {
    return { status: 'amber', daysToDue: days, dueOn: due, reason: `${dueText.charAt(0).toUpperCase() + dueText.slice(1)}${pending}` };
  }
  if (v) {
    return { status: 'green', daysToDue: days, dueOn: due, reason: `Compliant / verified: ${v.ref} closed ${v.closedOn ? uk(v.closedOn) : ''} (${days} days to next due)` };
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
