import { describe, expect, it } from 'vitest';
import { evaluateActivity, reminderThreshold, type ActivityInput } from '../server/compliance';
import { addMonths, daysBetween, londonToday } from '../server/dates';

const base: ActivityInput = {
  applicability: 'required', naReason: '', lastDoneOn: null, nextDueOn: null, expiresOn: null, intervalMonths: null,
  evidenceRequired: true, evidence: { verified: true, validUntil: null }, openCriticalActions: 0, warningDays: 30,
};
const today = '2026-11-08';

describe('date helpers', () => {
  it('uses Europe/London calendar day (BST and GMT)', () => {
    expect(londonToday(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02'); // BST: 00:30 next day
    expect(londonToday(new Date('2026-12-01T23:30:00Z'))).toBe('2026-12-01'); // GMT
  });
  it('clamps month addition and handles leap day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('counts whole days across DST change', () => {
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });
});

describe('evaluateActivity', () => {
  it('due today is amber; overdue begins the next day', () => {
    expect(evaluateActivity({ ...base, nextDueOn: today }, today).status).toBe('amber');
    expect(evaluateActivity({ ...base, nextDueOn: '2026-11-07' }, today)).toMatchObject({ status: 'red', daysToDue: -1 });
  });
  it('green outside the warning window, amber inside', () => {
    expect(evaluateActivity({ ...base, nextDueOn: '2026-12-08' }, today).status).toBe('amber'); // 30 days
    expect(evaluateActivity({ ...base, nextDueOn: '2026-12-09' }, today).status).toBe('green');
  });
  it('missing or unverified required evidence => grey unless red', () => {
    expect(evaluateActivity({ ...base, nextDueOn: '2027-06-01', evidence: null }, today).status).toBe('grey');
    expect(evaluateActivity({ ...base, nextDueOn: '2027-06-01', evidence: { verified: false, validUntil: null } }, today).status).toBe('grey');
    expect(evaluateActivity({ ...base, nextDueOn: '2026-11-10', evidence: null }, today).status).toBe('grey');
    expect(evaluateActivity({ ...base, nextDueOn: '2026-11-01', evidence: null }, today).status).toBe('red');
    expect(evaluateActivity({ ...base, nextDueOn: '2027-06-01', evidence: null, evidenceRequired: false }, today).status).toBe('green');
  });
  it('derives due from last done + interval, and verified validity can expire it', () => {
    expect(evaluateActivity({ ...base, lastDoneOn: '2025-11-20', intervalMonths: 12 }, today)).toMatchObject({ dueOn: '2026-11-20', status: 'amber' });
    expect(evaluateActivity({ ...base, nextDueOn: '2027-06-01', evidence: { verified: true, validUntil: '2026-11-01' } }, today))
      .toMatchObject({ status: 'red', reason: 'Expired by 7 days' });
  });
  it('critical open action => red; N/A and unknown handled', () => {
    expect(evaluateActivity({ ...base, nextDueOn: '2027-06-01', openCriticalActions: 1 }, today).status).toBe('red');
    expect(evaluateActivity({ ...base, applicability: 'not_applicable', naReason: 'none' }, today).status).toBe('na');
    expect(evaluateActivity({ ...base, applicability: 'unknown' }, today).status).toBe('grey');
    expect(evaluateActivity({ ...base }, today).status).toBe('grey');
  });
  it('reminder thresholds pick tightest window', () => {
    expect(reminderThreshold(5, [30, 14, 7])).toBe('7d');
    expect(reminderThreshold(20, [30, 14, 7])).toBe('30d');
    expect(reminderThreshold(31, [30, 14, 7])).toBeNull();
    expect(reminderThreshold(-1, [30, 14, 7])).toBe('overdue');
  });
});
