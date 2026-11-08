// Reminder text, .eml rendering and the demo mail adapter (writes to a local outbox folder).
// There is deliberately NO real SMTP/Graph transport in P0. Nothing here is called by Recalculate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from './db.js';
import { ukDate } from './dates.js';

export const FROM_ADDRESS = 'Property Hub (demo) <propertyhub@localhost.test>';
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isEmail(v: string): boolean {
  return EMAIL_RE.test(v);
}

/** Duplicate key: (activity, due date, threshold, recipient). */
export function messageKey(activityId: number, dueOn: string, threshold: string, email: string) {
  return `A${activityId}|${dueOn}|${threshold}|${email.trim().toLowerCase()}`;
}

export function buildReminderText(o: {
  activityRef: string;
  typeName: string;
  locationCodes: string;
  dueOn: string;
  daysToDue: number;
  recipientName: string;
}) {
  const when =
    o.daysToDue < 0
      ? `OVERDUE by ${-o.daysToDue} day${o.daysToDue === -1 ? '' : 's'}`
      : o.daysToDue === 0
        ? 'due TODAY'
        : `due in ${o.daysToDue} day${o.daysToDue === 1 ? '' : 's'}`;
  const subject = `[Property Hub] ${o.activityRef} ${o.typeName} ${when} (${ukDate(o.dueOn)})`;
  // Minimal details only: reference codes, type, due date. No addresses or resident information.
  const body = [
    `Hello${o.recipientName ? ` ${o.recipientName}` : ''},`,
    '',
    `This is a reminder that the following compliance activity is ${when}:`,
    '',
    `  Activity: ${o.activityRef}`,
    `  Type: ${o.typeName}`,
    `  Location: ${o.locationCodes}`,
    `  Due date: ${ukDate(o.dueOn)}`,
    '',
    'Please contact the Compliance Officer to arrange the work or to confirm it has been completed.',
    '',
    'Property Hub (sent manually by the Compliance Officer)',
  ].join('\n');
  return { subject, body };
}

export function composeBody(draft: string, extraMessage: string): string {
  const msg = extraMessage.trim();
  if (!msg) return draft;
  const lines = draft.split('\n');
  return [lines[0], '', msg, ...lines.slice(1)].join('\n');
}

export function renderEml(o: { to: string; subject: string; body: string; date: Date; draft: boolean }): string {
  const encSubject = /[^\x20-\x7e]/.test(o.subject) ? `=?UTF-8?B?${Buffer.from(o.subject, 'utf8').toString('base64')}?=` : o.subject;
  const headers = [
    `From: ${FROM_ADDRESS}`,
    `To: ${o.to}`,
    `Subject: ${encSubject}`,
    `Date: ${o.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@localhost.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (o.draft) headers.push('X-Unsent: 1');
  return `${headers.join('\r\n')}\r\n\r\n${o.body.replace(/\r?\n/g, '\r\n')}\r\n`;
}

export interface CandidateRow {
  id: number;
  run_id: number;
  activity_id: number;
  user_id: number | null;
  recipient_name: string;
  recipient_email: string;
  threshold: string;
  due_on: string;
  days_to_due: number;
  message_key: string;
  subject: string;
  draft_text: string;
  selected: number;
}

export interface SendResult {
  candidateId: number;
  outcome: 'sent' | 'exported' | 'failed' | 'skipped_duplicate';
  detail: string;
  file?: string;
}

export function alreadySent(db: DB, key: string): string | null {
  const row = db
    .prepare(`SELECT sent_at FROM email_log WHERE message_key = ? AND outcome = 'sent' ORDER BY id DESC LIMIT 1`)
    .get(key) as { sent_at: string } | undefined;
  return row?.sent_at ?? null;
}

function toHeader(c: CandidateRow) {
  return c.recipient_name ? `"${c.recipient_name.replace(/["\r\n]/g, '')}" <${c.recipient_email}>` : c.recipient_email;
}

export function candidateEml(c: CandidateRow, extra: string, now: Date, draft: boolean) {
  return renderEml({ to: toHeader(c), subject: c.subject, body: composeBody(c.draft_text, extra), date: now, draft });
}

const logStmt = (db: DB) =>
  db.prepare(
    `INSERT INTO email_log (candidate_id, message_key, recipient_email, subject, mode, outcome, resend, sent_at, detail, outbox_file)
     VALUES (@candidate_id, @message_key, @recipient_email, @subject, @mode, @outcome, @resend, @sent_at, @detail, @outbox_file)`,
  );

/**
 * Demo mail adapter: "delivers" by writing an .eml into the local outbox folder.
 * Only ever invoked from the explicit "Send selected (demo)" endpoint.
 */
export function sendReminders(
  db: DB,
  outboxDir: string,
  candidateIds: number[],
  opts: { message: string; resend: boolean; now: Date },
): SendResult[] {
  const get = db.prepare('SELECT * FROM reminder_candidates WHERE id = ?');
  const log = logStmt(db);
  const results: SendResult[] = [];
  const nowIso = opts.now.toISOString();
  fs.mkdirSync(outboxDir, { recursive: true });

  for (const id of candidateIds) {
    const c = get.get(id) as CandidateRow | undefined;
    if (!c) {
      results.push({ candidateId: id, outcome: 'failed', detail: 'Reminder candidate not found' });
      continue;
    }
    const base = { candidate_id: c.id, message_key: c.message_key, recipient_email: c.recipient_email, subject: c.subject, mode: 'demo_send', sent_at: nowIso, outbox_file: '' };
    if (!c.recipient_email || !isEmail(c.recipient_email)) {
      const detail = c.recipient_email ? `Invalid email address: ${c.recipient_email}` : 'No recipient email address';
      log.run({ ...base, outcome: 'failed', resend: 0, detail });
      results.push({ candidateId: id, outcome: 'failed', detail });
      continue;
    }
    const prev = alreadySent(db, c.message_key);
    if (prev && !opts.resend) {
      const detail = `Already sent ${prev}; tick Resend to override`;
      log.run({ ...base, outcome: 'skipped_duplicate', resend: 0, detail });
      results.push({ candidateId: id, outcome: 'skipped_duplicate', detail });
      continue;
    }
    try {
      const file = `${nowIso.replace(/[:.]/g, '-')}_${c.id}_${crypto.randomUUID().slice(0, 8)}.eml`;
      fs.writeFileSync(path.join(outboxDir, file), candidateEml(c, opts.message, opts.now, false), 'utf8');
      log.run({ ...base, outcome: 'sent', resend: prev ? 1 : 0, detail: 'Delivered to local demo outbox (no real email sent)', outbox_file: file });
      results.push({ candidateId: id, outcome: 'sent', detail: `Delivered to demo outbox (${file})`, file });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.run({ ...base, outcome: 'failed', resend: 0, detail });
      results.push({ candidateId: id, outcome: 'failed', detail });
    }
  }
  return results;
}

/** Writes unsent .eml drafts (X-Unsent: 1) to the local drafts folder. Does not count as sent. */
export function exportDrafts(db: DB, draftsDir: string, candidateIds: number[], opts: { message: string; now: Date }): SendResult[] {
  const get = db.prepare('SELECT * FROM reminder_candidates WHERE id = ?');
  const log = logStmt(db);
  fs.mkdirSync(draftsDir, { recursive: true });
  const nowIso = opts.now.toISOString();
  return candidateIds.map((id) => {
    const c = get.get(id) as CandidateRow | undefined;
    if (!c) return { candidateId: id, outcome: 'failed' as const, detail: 'Reminder candidate not found' };
    const file = `draft_${nowIso.replace(/[:.]/g, '-')}_${c.id}.eml`;
    fs.writeFileSync(path.join(draftsDir, file), candidateEml(c, opts.message, opts.now, true), 'utf8');
    log.run({
      candidate_id: c.id, message_key: c.message_key, recipient_email: c.recipient_email, subject: c.subject,
      mode: 'eml_export', outcome: 'exported', resend: 0, sent_at: nowIso, detail: 'Draft .eml exported (not sent)', outbox_file: file,
    });
    return { candidateId: id, outcome: 'exported' as const, detail: `Draft written (${file})`, file };
  });
}
