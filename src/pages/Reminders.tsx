import { useState } from 'react';
import { api, type Row } from '../api';
import { Card, DataTable, ErrorBox, Field, Loading, Modal, Page } from '../components';
import { fmtDate, fmtDateTime, useLoad } from '../util';

export function Reminders() {
  const { data, error, reload, setData } = useLoad<Row>('/api/reminders');
  const { data: log, reload: reloadLog } = useLoad<Row[]>('/api/email-log');
  const [preview, setPreview] = useState<Row | null>(null);
  const [message, setMessage] = useState('');
  const [resend, setResend] = useState(false);
  const [results, setResults] = useState<Row[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.run) {
    return (
      <Page title="Reminders">
        <div className="note">No reminder candidates yet. They are generated only when you click <strong>Recalculate Compliance</strong>. Nothing is ever sent automatically.</div>
      </Page>
    );
  }
  const cands: Row[] = data.candidates;
  const selected = cands.filter((c) => c.selected).map((c) => c.id);

  const toggle = async (c: Row, v: boolean) => {
    setData({ ...data, candidates: cands.map((x) => (x.id === c.id ? { ...x, selected: v ? 1 : 0 } : x)) });
    try {
      await api.patch(`/api/reminders/${c.id}`, { selected: v });
    } catch (e: any) {
      setErr(e.message);
      reload();
    }
  };
  const all = async (v: boolean) => {
    await Promise.all(cands.filter((c) => !!c.selected !== v).map((c) => api.patch(`/api/reminders/${c.id}`, { selected: v })));
    reload();
  };
  const go = async (kind: 'send' | 'export') => {
    setErr(null);
    setNote(null);
    try {
      const r = await api.post(`/api/reminders/${kind}`, { ids: selected, message, resend });
      setResults(r.results);
      setNote(kind === 'send' ? r.note : `Draft .eml files written to ${r.folder}`);
      reload();
      reloadLog();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Page title="Reminders">
      <div className="note">
        Candidates from the recalculation run at <strong>{fmtDateTime(data.run.createdAt)}</strong> (as of {fmtDate(data.run.asOfDate)}). Review, edit and select drafts, then
        export or demo-send manually. <strong>Demo mode:</strong> no real email is ever sent — messages go to the local outbox folder only.
      </div>
      <ErrorBox error={err} />
      <Card
        title={`Reminder candidates (${cands.length}) · ${selected.length} selected`}
        actions={<><button onClick={() => all(true)}>Select all</button> <button onClick={() => all(false)}>Clear</button></>}
      >
        <DataTable
          rows={cands}
          initialSort={{ key: 'days_to_due', dir: 1 }}
          cols={[
            { key: 'selected', label: '✓', render: (c) => <input type="checkbox" aria-label={`Select ${c.activity_ref}`} checked={!!c.selected} onChange={(e) => toggle(c, e.target.checked)} /> },
            { key: 'activity_ref', label: 'Activity', render: (c) => <a href={`#/activities/${c.activity_id}`}>{c.activity_ref}</a> },
            { key: 'type_name', label: 'Type' },
            { key: 'loc', label: 'Location', render: (c) => [c.area_code, c.site_code, c.room_code].filter(Boolean).join(' › ') },
            { key: 'threshold', label: 'Threshold', render: (c) => (c.threshold === 'overdue' ? <span className="warn">Overdue</span> : c.threshold) },
            { key: 'due_on', label: 'Due', render: (c) => fmtDate(c.due_on) },
            { key: 'days_to_due', label: 'Days', className: 'num' },
            { key: 'recipient', label: 'Recipient', render: (c) => (c.recipient_email ? `${c.recipient_name} <${c.recipient_email}>` : <span className="warn">No recipient email</span>) },
            { key: 'sent', label: 'Already sent', render: (c) => (c.already_sent_at ? fmtDateTime(c.already_sent_at) : '—') },
            { key: 'last_outcome', label: 'Last outcome', render: (c) => c.last_outcome ?? '—' },
            { key: 'p', label: '', render: (c) => <><button className="btn-ghost small" onClick={() => setPreview(c)}>Preview / edit</button> <a className="small" href={`/api/reminders/${c.id}/eml`}>.eml</a></> },
          ]}
        />
      </Card>
      <Card title="Send / export selected (manual)">
        <Field label="Optional extra message added to each email"><textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
        <label className="inline"><input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} /> Resend even if already sent (overrides duplicate guard)</label>
        <div className="form-actions">
          <button disabled={!selected.length} onClick={() => go('export')}>Export {selected.length} draft(s) as .eml</button>
          <button className="btn-primary" disabled={!selected.length} onClick={() => go('send')}>Demo send {selected.length} (local outbox only)</button>
        </div>
        {note && <div className="note">{note}</div>}
        {results && (
          <ul className="link-list">
            {results.map((r) => <li key={r.candidateId}><span className={`tag tag-${r.outcome}`}>{r.outcome}</span> #{r.candidateId}: {r.detail}</li>)}
          </ul>
        )}
      </Card>
      <Card title="Email log">
        <DataTable
          rows={log ?? []}
          empty="Nothing sent or exported yet"
          cols={[
            { key: 'sent_at', label: 'When', render: (l) => fmtDateTime(l.sent_at) },
            { key: 'mode', label: 'Mode' },
            { key: 'outcome', label: 'Outcome', render: (l) => <span className={`tag tag-${l.outcome}`}>{l.outcome}</span> },
            { key: 'recipient_email', label: 'Recipient' },
            { key: 'subject', label: 'Subject' },
            { key: 'detail', label: 'Detail' },
          ]}
        />
      </Card>
      {preview && <PreviewModal c={preview} onClose={() => setPreview(null)} onSaved={() => { setPreview(null); reload(); }} />}
    </Page>
  );
}

function PreviewModal({ c, onClose, onSaved }: { c: Row; onClose: () => void; onSaved: () => void }) {
  const [subject, setSubject] = useState(c.subject);
  const [body, setBody] = useState(c.draft_text);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={`Draft reminder · ${c.activity_ref}`} onClose={onClose}>
      <ErrorBox error={err} />
      <p className="muted small">To: {c.recipient_email ? `${c.recipient_name} <${c.recipient_email}>` : '(no recipient — cannot be sent)'}</p>
      <Field label="Subject"><input className="wide" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Message"><textarea className="wide mono" rows={12} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn-primary" onClick={async () => {
          try {
            await api.patch(`/api/reminders/${c.id}`, { subject, draft_text: body });
            onSaved();
          } catch (e: any) {
            setErr(e.message);
          }
        }}>Save draft</button>
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
