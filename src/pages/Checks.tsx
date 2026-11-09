import { useMemo, useRef, useState } from 'react';
import { api, type Core, type Row } from '../api';
import { Card, DataTable, ErrorBox, Field, Loading, LocationSelects, Modal, Page, StatusChip, Tabs, useStoredState, type Col, type LocFilter } from '../components';
import { addMonths, fmtDate, fmtStamp, londonToday, navigate, STATUS_LABEL, useLoad } from '../util';
import { ActionModal } from './Actions';

export const OUTCOMES = ['Satisfactory', 'Satisfactory with advisories', 'Unsatisfactory', 'Not completed'];
const OUTCOME_HELP: Record<string, string> = {
  Satisfactory: 'Work completed, no defects. Updates last inspection date and next due.',
  'Satisfactory with advisories': 'Completed with advisory notes. Updates the schedule.',
  Unsatisfactory: 'Completed but failed / defects found. Updates the schedule and makes the activity red at the next Recalculate until a satisfactory check is recorded.',
  'Not completed': 'Attempted but not carried out (e.g. no access). Kept in history; the schedule is NOT changed.',
};

export function OutcomeTag({ o }: { o: string }) {
  const cls = o === 'Unsatisfactory' ? 'state-overdue' : o === 'Not completed' ? 'state-in-progress' : 'state-done';
  return <span className={`state ${cls}`}>{o}</span>;
}

// ---------- record / amend form ----------
export function CheckForm({ activityId, amendId }: { activityId?: number; amendId?: number }) {
  const { data: orig } = useLoad<Row>(amendId ? `/api/checks/${amendId}` : null);
  const actId = activityId ?? orig?.activity_id;
  const { data: a } = useLoad<Row>(actId ? `/api/activities/${actId}` : null, [actId]);
  const { data: core } = useLoad<Core>('/api/core');
  const { data: library } = useLoad<Row[]>('/api/documents');
  const [f, setF] = useState<Row | null>(null);
  const [certMode, setCertMode] = useState<'none' | 'upload' | 'library'>('none');
  const [file, setFile] = useState<File | null>(null);
  const [docQ, setDocQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!a || !core || (amendId && !orig)) return <Loading />;
  if (!f) {
    const base = orig ?? {};
    setF({
      performed_on: base.performed_on ?? londonToday(), inspector_user_id: String(base.inspector_user_id ?? ''), provider_name: base.provider_name ?? '',
      outcome: base.outcome ?? 'Satisfactory', notes: base.notes ?? '', certificate_document_id: base.certificate_document_id ? String(base.certificate_document_id) : '',
      certificate_issued_on: base.certificate_issued_on ?? '', certificate_valid_until: base.certificate_valid_until ?? '', verify_certificate: !!base.certificate_verified,
      next_due_override: !!base.next_due_override, next_due_on: base.next_due_override ? base.next_due_on : '', override_reason: base.override_reason ?? '',
      amendment_reason: '',
    });
    if (base.certificate_document_id) setCertMode('library');
    return <Loading />;
  }
  const u = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const interval: number | null = a.effective_interval;
  const proposed = f.performed_on && interval ? addMonths(f.performed_on, interval) : null;
  const notCompleted = f.outcome === 'Not completed';
  const docs = (library ?? []).filter((d) => `DOC-${d.id} ${d.display_name} ${d.original_filename}`.toLowerCase().includes(docQ.toLowerCase()));
  const chosen = (library ?? []).find((d) => String(d.id) === String(f.certificate_document_id));

  const save = async () => {
    setErr(null);
    if (!f.inspector_user_id && !f.provider_name.trim()) return setErr('Record who carried out the check: choose a person and/or enter the engineer or provider.');
    if (f.next_due_override && (!f.next_due_on || !f.override_reason.trim())) return setErr('Enter the override date and a reason, or untick Override.');
    if (amendId && !f.amendment_reason.trim()) return setErr('Give the reason for this amendment.');
    if (certMode === 'upload' && !file) return setErr('Choose the certificate file to upload, or select "No certificate".');
    if (certMode === 'library' && !f.certificate_document_id) return setErr('Choose a certificate from the library, or select "No certificate".');
    setSaving(true);
    try {
      let certId: number | null = certMode === 'library' ? Number(f.certificate_document_id) : null;
      if (certMode === 'upload' && file) {
        const fd = new FormData();
        fd.append('file', file);
        certId = (await api.post('/api/documents', fd)).id;
      }
      const body: Row = {
        performed_on: f.performed_on, inspector_user_id: f.inspector_user_id || null, provider_name: f.provider_name, outcome: f.outcome, notes: f.notes,
        certificate_document_id: certId,
        ...(certId ? { certificate_issued_on: f.certificate_issued_on || f.performed_on, certificate_valid_until: f.certificate_valid_until || null, verify_certificate: !!f.verify_certificate } : {}),
        next_due_override: !!f.next_due_override, next_due_on: f.next_due_override ? f.next_due_on : null, override_reason: f.next_due_override ? f.override_reason : '',
      };
      if (amendId) await api.post(`/api/checks/${amendId}/amend`, { ...body, amendment_reason: f.amendment_reason });
      else await api.post('/api/checks', { ...body, activity_id: a.id });
      navigate(`#/activities/${a.id}?tab=history&msg=${amendId ? 'amended' : 'recorded'}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page
      crumbs={<><a href="#/activities">Compliance Activities</a> › <a href={`#/activities/${a.id}`}>{a.ref}</a></>}
      title={amendId ? `Amend ${orig!.ref}` : 'Record Inspection / Check'}
    >
      <Card title="Compliance activity (type and location are inherited)">
        <dl className="dl">
          <div><dt>Activity</dt><dd><strong>{a.ref}</strong> · {a.type_code} — {a.type_name}{a.name ? ` · ${a.name}` : ''}</dd></div>
          <div><dt>Location</dt><dd>{[a.area_code, a.site_code && `${a.site_code} ${a.site_name}`, a.room_code && `${a.room_code} ${a.room_name}`].filter(Boolean).join(' › ')}</dd></div>
          <div><dt>Current schedule</dt><dd>Last done {fmtDate(a.last_done_on)} · next due {fmtDate(a.next_due_on)}{a.next_due_override ? ' (override)' : ''} · interval {interval ?? '—'} months</dd></div>
          <div><dt>Current status</dt><dd><StatusChip status={a.status} /> {a.status_reason}</dd></div>
        </dl>
      </Card>
      {amendId && (
        <div className="note">
          You are correcting <strong>{orig!.ref}</strong> (performed {fmtDate(orig!.performed_on)}). A new record will be created that supersedes it;
          the original stays in the history, marked as superseded, with your reason.
        </div>
      )}
      <ErrorBox error={err} />
      <div className="grid2">
        <Card title="1. What was done">
          <Field label="Performed on"><input aria-label="Performed on" type="date" max={londonToday()} value={f.performed_on} onChange={u('performed_on')} /></Field>
          <div className="grid2">
            <Field label="Inspector (staff/contact)">
              <select aria-label="Check inspector" value={f.inspector_user_id} onChange={u('inspector_user_id')}>
                <option value="">— none —</option>
                {core.users.filter((x) => x.active || String(x.id) === f.inspector_user_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <Field label="Engineer / provider"><input aria-label="Provider" value={f.provider_name} onChange={u('provider_name')} placeholder="e.g. Contractor name, engineer ID" /></Field>
          </div>
          <Field label="Outcome" hint={OUTCOME_HELP[f.outcome]}>
            <select aria-label="Outcome" value={f.outcome} onChange={u('outcome')}>
              {OUTCOMES.map((o) => <option key={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Notes"><textarea aria-label="Check notes" rows={3} value={f.notes} onChange={u('notes')} /></Field>
          {amendId && <Field label="Reason for amendment (required)"><textarea aria-label="Amendment reason" rows={2} value={f.amendment_reason} onChange={u('amendment_reason')} /></Field>}
        </Card>
        <Card title="2. Certificate / evidence">
          <div className="radio-row">
            {([['none', 'No certificate'], ['upload', 'Upload new file'], ['library', 'Choose from library']] as const).map(([k, l]) => (
              <label key={k} className="inline"><input type="radio" name="cert" checked={certMode === k} onChange={() => setCertMode(k)} /> {l}</label>
            ))}
          </div>
          {certMode === 'upload' && (
            <Field label="Certificate file" hint="Stored once in the central library and linked to this activity.">
              <input ref={fileRef} aria-label="Certificate file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
          )}
          {certMode === 'library' && (
            <>
              <input className="wide" placeholder="Search library…" value={docQ} onChange={(e) => setDocQ(e.target.value)} />
              <select aria-label="Library certificate" className="wide" size={5} value={f.certificate_document_id} onChange={u('certificate_document_id')}>
                {docs.slice(0, 200).map((d) => <option key={d.id} value={d.id}>DOC-{d.id} {d.display_name} {d.verified_by_operator ? '(verified)' : ''}</option>)}
              </select>
              {chosen && <p className="small muted">Selected: DOC-{chosen.id} {chosen.display_name}</p>}
            </>
          )}
          {certMode !== 'none' && (
            <>
              <div className="grid2">
                <Field label="Issued on" hint="Blank = performed date"><input aria-label="Certificate issued" type="date" value={f.certificate_issued_on} onChange={u('certificate_issued_on')} /></Field>
                <Field label="Valid until (optional)"><input aria-label="Certificate valid until" type="date" value={f.certificate_valid_until} onChange={u('certificate_valid_until')} /></Field>
              </div>
              <label className="inline verify-box">
                <input type="checkbox" aria-label="Verify certificate" checked={!!f.verify_certificate} onChange={(e) => setF({ ...f, verify_certificate: e.target.checked })} />
                I have reviewed this certificate — mark it as <strong>verified evidence</strong>
              </label>
              <p className="muted small">Unverified certificates never make an activity green. You can verify later from the Documents panel.</p>
            </>
          )}
          {certMode === 'none' && a.evidence_required ? <p className="warn small">This type requires verified evidence; without it the activity will show Unknown / missing after Recalculate.</p> : null}
        </Card>
        <Card title="3. Next due">
          {notCompleted ? (
            <p>Outcome is <strong>Not completed</strong>: the schedule will not change (next due stays {fmtDate(a.next_due_on)}).</p>
          ) : (
            <>
              <div className={`calc-due ${f.next_due_override ? 'superseded' : ''}`} data-testid="proposed-next-due">
                Proposed next due: <strong>{proposed ? fmtDate(proposed) : '—'}</strong>
                <span className="muted small"> {proposed ? `(${fmtDate(f.performed_on)} + ${interval} months)` : '(no interval: enter an override)'}</span>
              </div>
              <label className="inline">
                <input type="checkbox" aria-label="Override proposed next due" checked={!!f.next_due_override}
                  onChange={(e) => setF({ ...f, next_due_override: e.target.checked, next_due_on: e.target.checked ? (f.next_due_on || proposed || '') : '' })} />
                Override the proposed date
              </label>
              {f.next_due_override && (
                <div className="grid2 override-fields">
                  <Field label="Override next due"><input aria-label="Check override date" type="date" value={f.next_due_on} onChange={u('next_due_on')} /></Field>
                  <Field label="Reason (required)"><input aria-label="Check override reason" value={f.override_reason} onChange={u('override_reason')} /></Field>
                </div>
              )}
              {a.last_done_on && f.performed_on < a.last_done_on && (
                <p className="warn small">This date is earlier than the current last inspection ({fmtDate(a.last_done_on)}). It will be kept in history but will not change the schedule.</p>
              )}
            </>
          )}
          <p className="muted small">Saving records this event and updates the schedule. <strong>Status changes only when you click Recalculate Compliance.</strong></p>
        </Card>
      </div>
      <div className="form-actions">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : amendId ? 'Save amendment' : 'Save inspection / check'}</button>
        <a className="btn" href={`#/activities/${a.id}`}>Cancel</a>
      </div>
    </Page>
  );
}

// ---------- activity history (checks first; calculation history separate) ----------
interface SnapGroup { id: string; first: string; last: string; count: number; status: string; due_on: string | null; reason: string }

/** Collapse consecutive runs with an identical outcome into one row (newest first). */
export function groupSnapshots(snaps: Row[]): SnapGroup[] {
  const out: SnapGroup[] = [];
  for (const s of snaps) {
    const prev = out[out.length - 1];
    if (prev && prev.status === s.status && prev.due_on === s.due_on && prev.reason === s.reason) {
      prev.first = s.run_at;
      prev.count++;
    } else out.push({ id: String(s.run_id), first: s.run_at, last: s.run_at, count: 1, status: s.status, due_on: s.due_on, reason: s.reason });
  }
  return out;
}

const SCHED_SOURCE: Record<string, string> = { edit: 'Manual edit', check: 'Check recorded', amendment: 'Amendment', 'type-interval': 'Type interval changed', migration: 'Upgrade' };

export function ActivityHistory({ a }: { a: Row }) {
  const { data } = useLoad<Row>(`/api/activities/${a.id}/history`);
  const [view, setView] = useState('checks');
  const [shown, setShown] = useState(10);
  const [actionFor, setActionFor] = useState<Row | null>(null);
  const groups = useMemo(() => (data ? groupSnapshots(data.snapshots) : []), [data]);
  if (!data) return <Loading />;
  const checks: Row[] = data.checks;
  const checkCols: Col[] = [
    { key: 'ref', label: 'Ref', render: (c) => <strong className={c.superseded_by_id ? 'struck' : ''}>{c.ref}</strong> },
    { key: 'performed_on', label: 'Performed', render: (c) => fmtDate(c.performed_on) },
    { key: 'outcome', label: 'Outcome', render: (c) => <OutcomeTag o={c.outcome} /> },
    { key: 'inspector', label: 'Inspector / provider', render: (c) => [c.inspector_user_name, c.provider_name].filter(Boolean).join(' · ') || '—' },
    { key: 'certificate', label: 'Certificate', render: (c) => c.certificate_document_id
      ? <><a href={`/api/documents/${c.certificate_document_id}/file`} target="_blank" rel="noreferrer">{c.certificate_name}</a> {c.certificate_verified ? <span className="ok">✔ verified</span> : <span className="warn">not verified</span>}{c.certificate_valid_until && <span className="muted small"> · valid to {fmtDate(c.certificate_valid_until)}</span>}</>
      : <span className="muted">None</span> },
    { key: 'next_due_on', label: 'Next due set', render: (c) => c.outcome === 'Not completed' ? '—' : <>{fmtDate(c.next_due_on)}{c.next_due_override ? <span className="override-tag">Override</span> : null}</> },
    { key: 'status', label: 'Record', render: (c) => c.superseded_by_id
      ? <span className="muted small">Superseded by {c.superseded_by_ref}</span>
      : <span className="small">
          {c.id === a.schedule_check_id ? <strong>Sets current schedule</strong> : c.schedule_applied ? 'Previous cycle' : <span className="muted">History only (schedule unchanged)</span>}
          {c.amends_ref && <><br />Amends {c.amends_ref}: <em>{c.amendment_reason}</em></>}
        </span> },
    { key: 'x', label: '', render: (c) => (
      <span className="nowrap">
        {!c.superseded_by_id && <a className="small" href={`#/checks/${c.id}/amend`}>Amend…</a>}
        {!c.superseded_by_id && c.outcome === 'Unsatisfactory' && <> <button className="btn-ghost small" onClick={() => setActionFor(c)}>Raise action</button></>}
      </span>
    ) },
  ];
  return (
    <>
      <Tabs
        active={view}
        onChange={setView}
        tabs={[
          { key: 'checks', label: 'Inspection / Check history', count: checks.filter((c) => !c.superseded_by_id).length },
          { key: 'schedule', label: 'Schedule changes', count: data.schedule.length },
          { key: 'calc', label: 'Calculation history', count: groups.length },
          { key: 'reminders', label: 'Reminders', count: data.emails.length },
        ]}
      />
      {view === 'checks' && (
        <Card title="Inspection / check history (latest first)" actions={!a.archived_at && <a className="btn btn-primary" href={`#/activities/${a.id}/check`}>Record Inspection / Check</a>}>
          <DataTable cols={checkCols} rows={checks} empty="No inspections or checks recorded yet" />
          {checks.some((c) => c.notes) && (
            <ul className="link-list small">
              {checks.filter((c) => c.notes).map((c) => <li key={c.id}><strong>{c.ref}</strong>: {c.notes}</li>)}
            </ul>
          )}
          <p className="muted small">Records are never edited in place. "Amend…" creates a corrected record that supersedes the original, which stays visible here.</p>
        </Card>
      )}
      {view === 'schedule' && (
        <Card title="Schedule changes (traceable)">
          <DataTable
            rows={data.schedule}
            empty="No schedule changes recorded"
            cols={[
              { key: 'changed_at', label: 'When', render: (l) => fmtStamp(l.changed_at) },
              { key: 'source', label: 'Source', render: (l) => <>{SCHED_SOURCE[l.source] ?? l.source}{l.check_ref ? ` (${l.check_ref})` : ''}</> },
              { key: 'last', label: 'Last done', render: (l) => l.old_last_done === l.new_last_done ? fmtDate(l.new_last_done) : <>{fmtDate(l.old_last_done)} → <strong>{fmtDate(l.new_last_done)}</strong></> },
              { key: 'next', label: 'Next due', render: (l) => <>{l.old_next_due === l.new_next_due ? fmtDate(l.new_next_due) : <>{fmtDate(l.old_next_due)} → <strong>{fmtDate(l.new_next_due)}</strong></>}{l.new_override ? <span className="override-tag">Override</span> : null}</> },
              { key: 'note', label: 'Note' },
            ]}
          />
        </Card>
      )}
      {view === 'calc' && (
        <Card title="Calculation history (manual Recalculate snapshots)">
          <p className="muted small">Consecutive runs with an identical result are collapsed into one row.</p>
          <DataTable
            rows={groups.slice(0, shown)}
            empty="Never calculated"
            cols={[
              { key: 'last', label: 'Calculated', render: (g) => g.count > 1 ? <>{fmtStamp(g.first)} – {fmtStamp(g.last)}</> : fmtStamp(g.last) },
              { key: 'count', label: 'Runs', className: 'num' },
              { key: 'status', label: 'Status', render: (g) => <StatusChip status={g.status} /> },
              { key: 'due_on', label: 'Due used', render: (g) => fmtDate(g.due_on) },
              { key: 'reason', label: 'Reason' },
            ]}
          />
          {groups.length > shown && <button onClick={() => setShown(shown + 10)}>Show {Math.min(10, groups.length - shown)} more</button>}
        </Card>
      )}
      {view === 'reminders' && (
        <Card title="Reminder log">
          <DataTable
            rows={data.emails}
            empty="No reminders sent or exported"
            cols={[
              { key: 'sent_at', label: 'When', render: (l) => fmtStamp(l.sent_at) },
              { key: 'mode', label: 'Mode' },
              { key: 'outcome', label: 'Outcome' },
              { key: 'recipient_email', label: 'Recipient' },
              { key: 'subject', label: 'Subject' },
            ]}
          />
        </Card>
      )}
      {actionFor && (
        <ActionModal
          context={{ activity_id: a.id, site_id: a.site_id, room_id: a.location_level === 'room' ? a.room_id : null, owner_user_id: a.owner_user_id,
            title: `Remedial work after ${actionFor.ref} (${a.type_code})`, description: actionFor.notes }}
          onClose={() => setActionFor(null)}
          onSaved={(x) => navigate(`#/actions/${x.id}`)}
        />
      )}
    </>
  );
}

// ---------- start chooser + activity picker (Inspections page) ----------
export function StartChooser({ onRoutine, onClose }: { onRoutine: () => void; onClose: () => void }) {
  const [picking, setPicking] = useState(false);
  if (picking) return <ActivityPicker onClose={onClose} />;
  return (
    <Modal title="Start an inspection" onClose={onClose}>
      <div className="choice-grid">
        <button className="choice" onClick={onRoutine}>
          <strong>Routine Property Inspection</strong>
          <span>30-point visual walk-round of a Site (or one Room). Records observations and raises remedial actions. Not a statutory certificate.</span>
        </button>
        <button className="choice" onClick={() => setPicking(true)}>
          <strong>Compliance Inspection / Check</strong>
          <span>Record a statutory check (e.g. Gas Safety, EICR) against one Compliance Activity, with certificate. Updates its last inspection date and next due.</span>
        </button>
      </div>
    </Modal>
  );
}

export function ActivityPicker({ onClose }: { onClose: () => void }) {
  const { data: core } = useLoad<Core>('/api/core');
  const { data: acts } = useLoad<Row[]>('/api/activities');
  const [f, setF] = useStoredState<LocFilter & { type: string; q: string }>('ph:checkpick', { area: '', site: '', room: '', type: '', q: '' });
  if (!core || !acts) return <Modal title="Choose a Compliance Activity" onClose={onClose}><Loading /></Modal>;
  const q = f.q.toLowerCase();
  const rows = acts.filter((a) =>
    (!f.area || String(a.area_id) === f.area) && (!f.site || String(a.site_id) === f.site) && (!f.room || String(a.room_id) === f.room) &&
    (!f.type || String(a.type_id) === f.type) && (!q || `${a.ref} ${a.name} ${a.type_name} ${a.site_name} ${a.room_name ?? ''}`.toLowerCase().includes(q)));
  return (
    <Modal title="Compliance Inspection / Check — choose the activity" onClose={onClose}>
      <div className="filters">
        <LocationSelects core={core} value={f} onChange={(v) => setF({ ...f, ...v })} />
        <select aria-label="Picker type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">All types</option>
          {core.types.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
        </select>
        <input type="search" placeholder="Search ref or name…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <div className="pick-list">
        <DataTable
          rows={rows}
          onRowClick={(a) => navigate(`#/activities/${a.id}/check`)}
          empty="No activities match"
          cols={[
            { key: 'ref', label: 'Ref', render: (a) => <strong>{a.ref}</strong> },
            { key: 'type_code', label: 'Type' },
            { key: 'loc', label: 'Location', render: (a) => [a.site_code ?? a.area_code, a.room_code].filter(Boolean).join(' › ') },
            { key: 'last_done_on', label: 'Last done', render: (a) => fmtDate(a.last_done_on) },
            { key: 'next_due_on', label: 'Next due', render: (a) => fmtDate(a.next_due_on) },
            { key: 'status', label: 'Status', render: (a) => (a.status ? STATUS_LABEL[a.status] : '—') },
          ]}
        />
      </div>
    </Modal>
  );
}

// ---------- register of compliance checks (Inspections page tab) ----------
export function ChecksRegister() {
  const { data: core } = useLoad<Core>('/api/core');
  const { data: checks } = useLoad<Row[]>('/api/checks');
  const [f, setF] = useStoredState<LocFilter & { type: string; outcome: string; all: boolean; q: string }>('ph:checks', { area: '', site: '', room: '', type: '', outcome: '', all: false, q: '' });
  if (!core || !checks) return <Loading />;
  const q = f.q.toLowerCase();
  const rows = checks.filter((c) =>
    (f.all || !c.superseded_by_id) && (!f.area || String(c.area_id) === f.area) && (!f.site || String(c.site_id) === f.site) &&
    (!f.room || String(c.room_id) === f.room) && (!f.type || c.type_code === f.type) && (!f.outcome || c.outcome === f.outcome) &&
    (!q || `${c.ref} ${c.activity_ref} ${c.inspector ?? ''} ${c.site_name ?? ''} ${c.notes}`.toLowerCase().includes(q)));
  return (
    <>
      <div className="filters">
        <LocationSelects core={core} value={f} onChange={(v) => setF({ ...f, ...v })} />
        <select aria-label="Check type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">All types</option>
          {core.types.map((t) => <option key={t.id} value={t.code}>{t.code} — {t.name}</option>)}
        </select>
        <select aria-label="Check outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>
          <option value="">All outcomes</option>
          {OUTCOMES.map((o) => <option key={o}>{o}</option>)}
        </select>
        <label className="inline small"><input type="checkbox" checked={f.all} onChange={(e) => setF({ ...f, all: e.target.checked })} /> Include superseded records</label>
        <input type="search" placeholder="Search…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <Card>
        <DataTable
          rows={rows}
          onRowClick={(c) => navigate(`#/activities/${c.activity_id}?tab=history`)}
          empty="No compliance checks match"
          cols={[
            { key: 'ref', label: 'Ref', render: (c) => <strong className={c.superseded_by_id ? 'struck' : ''}>{c.ref}</strong> },
            { key: 'performed_on', label: 'Performed', render: (c) => fmtDate(c.performed_on) },
            { key: 'activity_ref', label: 'Activity', render: (c) => `${c.activity_ref} ${c.type_code}` },
            { key: 'loc', label: 'Location', render: (c) => [c.area_code, c.site_code, c.room_code].filter(Boolean).join(' › ') },
            { key: 'outcome', label: 'Outcome', render: (c) => <OutcomeTag o={c.outcome} /> },
            { key: 'inspector', label: 'Inspector / provider', render: (c) => [c.inspector_user_name, c.provider_name].filter(Boolean).join(' · ') || '—' },
            { key: 'certificate_verified', label: 'Certificate', render: (c) => c.certificate_document_id ? (c.certificate_verified ? <span className="ok">✔ verified</span> : <span className="warn">not verified</span>) : '—' },
            { key: 'next_due_on', label: 'Next due set', render: (c) => (c.outcome === 'Not completed' ? '—' : fmtDate(c.next_due_on)) },
            { key: 'amend', label: 'Record', render: (c) => c.superseded_by_id ? <span className="muted small">Superseded by {c.superseded_by_ref}</span> : c.amends_ref ? <span className="small">Amends {c.amends_ref}</span> : '' },
          ]}
        />
      </Card>
    </>
  );
}
