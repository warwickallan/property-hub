import { useEffect, useMemo, useState } from 'react';
import { api, downloadCsv, type Core, type Row } from '../api';
import { Card, DataTable, DocumentsPanel, ErrorBox, Field, Loading, LocationSelects, Modal, Page, StatusChip, Tabs, useStoredState, type Col, type LocFilter } from '../components';
import { addMonths, fmtDate, fmtStamp, londonToday, navigate, STATUS_LABEL, useLoad } from '../util';
import { REMEDIAL_COLS, RemedialModal, type RemedialContext } from './Actions';

export const VISIT_STATUS: Record<string, string> = {
  in_progress: 'Scheduled / In Progress',
  complete: 'Inspection Complete',
  complete_remedials: 'Complete with Remedials',
  awaiting_evidence: 'Awaiting Evidence',
  closed: 'Closed',
};
const RESPONSES = ['Pass', 'Issue', 'Not applicable', 'Not checked'];
const RESP_CLASS: Record<string, string> = { Pass: 'pass', Issue: 'issue', 'Not applicable': 'na', 'Not checked': 'nc' };

export function VisitStatusTag({ s }: { s: string | null | undefined }) {
  if (!s) return <span className="muted small">No visit</span>;
  return <span className={`vstate vstate-${s}`}>{VISIT_STATUS[s] ?? s}</span>;
}

export const VISIT_COLS: Col[] = [
  { key: 'ref', label: 'Visit', render: (v) => <strong>{v.ref}</strong> },
  { key: 'performed_on', label: 'Date', render: (v) => fmtDate(v.performed_on) },
  { key: 'activity_ref', label: 'Activity', render: (v) => (v.activity_ref ? `${v.activity_ref} ${v.type_code}` : <span className="warn">Needs review</span>) },
  { key: 'checklist_name', label: 'Checklist', render: (v) => v.checklist_name || <span className="muted">—</span> },
  { key: 'loc', label: 'Location', render: (v) => [v.site_code, v.room_code].filter(Boolean).join(' › ') || v.area_code },
  { key: 'inspector', label: 'Inspector / provider', render: (v) => v.inspector ?? '—' },
  { key: 'status', label: 'Status', render: (v) => <VisitStatusTag s={v.status} />, sort: (v) => Object.keys(VISIT_STATUS).indexOf(v.status) },
  { key: 'open_remedials', label: 'Remedials', className: 'num', render: (v) => (v.remedial_count ? <span className={v.open_remedials ? 'warn' : 'ok'}>{v.open_remedials} open / {v.remedial_count}</span> : '—') },
  { key: 'evidence', label: 'Evidence', render: (v) => (!v.evidence_required ? <span className="muted small">Not required</span> : v.verified_doc_count ? <span className="ok">✔ Verified</span> : <span className="warn">{v.doc_count ? 'Unverified' : 'Missing'}</span>) },
];

// ---------- start a visit (pick the Compliance Activity) ----------
export function StartVisitModal({ onClose, siteId, roomId }: { onClose: () => void; siteId?: number; roomId?: number }) {
  const { data: core } = useLoad<Core>('/api/core');
  const { data: acts } = useLoad<Row[]>('/api/activities');
  const [f, setF] = useState<LocFilter & { type: string; q: string }>({ area: '', site: siteId ? String(siteId) : '', room: roomId ? String(roomId) : '', type: '', q: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (core && siteId) setF((x) => ({ ...x, area: String(core.sites.find((s) => s.id === siteId)?.area_id ?? '') }));
  }, [core, siteId]);
  if (!core || !acts) return <Modal title="Start an inspection / visit" onClose={onClose}><Loading /></Modal>;
  const q = f.q.toLowerCase();
  const rows = acts.filter((a) => a.applicability !== 'not_applicable' &&
    (!f.area || String(a.area_id) === f.area) && (!f.site || String(a.site_id) === f.site) && (!f.room || String(a.room_id) === f.room) &&
    (!f.type || String(a.type_id) === f.type) && (!q || `${a.ref} ${a.name} ${a.type_name} ${a.checklist_name ?? ''} ${a.site_name}`.toLowerCase().includes(q)));
  const start = async (a: Row) => {
    setErr(null);
    if (a.open_visit_id) return navigate(`#/visits/${a.open_visit_id}`);
    try {
      const v = await api.post('/api/visits', { activity_id: a.id, inspector_user_id: a.owner_user_id });
      navigate(`#/visits/${v.id}`);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="Start an inspection / visit — choose the Compliance Activity" onClose={onClose}>
      <p className="muted small">Each visit is one occurrence of a scheduled Compliance Activity. Its checklist, location and schedule come from the activity.</p>
      <ErrorBox error={err} />
      <div className="filters">
        <LocationSelects core={core} value={f} onChange={(v) => setF({ ...f, ...v })} />
        <select aria-label="Picker type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">All types</option>
          {core.types.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
        </select>
        <input type="search" placeholder="Search…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <div className="pick-list">
        <DataTable
          rows={rows}
          onRowClick={start}
          initialSort={{ key: 'next_due_on', dir: 1 }}
          empty="No activities match"
          cols={[
            { key: 'ref', label: 'Activity', render: (a) => <strong>{a.ref}</strong> },
            { key: 'name', label: 'Name / checklist', render: (a) => <>{a.name || a.type_name}<div className="muted small">{a.checklist_name ?? 'No checklist'}</div></> },
            { key: 'loc', label: 'Location', render: (a) => [a.site_code ?? a.area_code, a.room_code].filter(Boolean).join(' › ') },
            { key: 'next_due_on', label: 'Next due', render: (a) => fmtDate(a.next_due_on) },
            { key: 'status', label: 'Status', render: (a) => <StatusChip status={a.status} /> },
            { key: 'go', label: '', render: (a) => <span className="small nowrap">{a.open_visit_id ? `Open ${a.open_visit_ref} →` : 'Start →'}</span> },
          ]}
        />
      </div>
    </Modal>
  );
}

// ---------- register ----------
interface Filters extends LocFilter { type: string; status: string; remedials: string; evidence: string; owner: string; from: string; to: string; q: string; review: boolean }
const EMPTY: Filters = { area: '', site: '', room: '', type: '', status: 'open', remedials: '', evidence: '', owner: '', from: '', to: '', q: '', review: false };

export function VisitsRegister() {
  const { data: core } = useLoad<Core>('/api/core');
  const { data, error } = useLoad<Row[]>('/api/visits');
  const [f, setF] = useStoredState<Filters>('ph:visits', EMPTY);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data || !core) return <Loading />;
  const q = f.q.toLowerCase();
  const rows = data.filter((v) =>
    (!f.area || String(v.area_id) === f.area) && (!f.site || String(v.site_id) === f.site) && (!f.room || String(v.room_id) === f.room) &&
    (!f.type || String(v.type_id) === f.type) && (f.status === 'open' ? v.status !== 'closed' : !f.status || v.status === f.status) &&
    (!f.remedials || (f.remedials === 'open' ? v.open_remedials > 0 : f.remedials === 'none' ? !v.remedial_count : v.remedial_count > 0 && !v.open_remedials)) &&
    (!f.evidence || (f.evidence === 'missing' ? v.evidence_required && !v.verified_doc_count : f.evidence === 'verified' ? v.evidence_required && v.verified_doc_count : !v.evidence_required)) &&
    (!f.owner || String(v.owner_user_id ?? '') === f.owner) && (!f.from || (v.performed_on && v.performed_on >= f.from)) && (!f.to || (v.performed_on && v.performed_on <= f.to)) &&
    (!f.review || v.needs_review) &&
    (!q || `${v.ref} ${v.activity_ref ?? ''} ${v.checklist_name} ${v.site_name ?? ''} ${v.inspector ?? ''} ${v.notes}`.toLowerCase().includes(q)));
  const completed = rows.filter((v) => v.completed_at);
  const count = (pred: (v: Row) => boolean) => data.filter(pred).length;
  return (
    <Page
      title="Inspections / Visits"
      actions={
        <>
          <button disabled={!completed.length} onClick={async () => {
            setErr(null);
            try { await downloadCsv('/api/export/visits', { ids: completed.map((v) => v.id) }, 'inspection-results.csv'); } catch (e: any) { setErr(e.message); }
          }}>Export results CSV ({completed.length})</button>
          <button className="btn-primary" onClick={() => setStarting(true)}>+ Start inspection</button>
        </>
      }
    >
      <ErrorBox error={err} />
      <div className="kpis">
        <button className="kpi kpi-plain" onClick={() => setF({ ...EMPTY, status: 'in_progress' })}><span className="kpi-value">{count((v) => v.status === 'in_progress')}</span><span className="kpi-label">In progress</span></button>
        <button className="kpi kpi-amber" onClick={() => setF({ ...EMPTY, status: 'complete_remedials' })}><span className="kpi-value">{count((v) => v.status === 'complete_remedials')}</span><span className="kpi-label">Remedials outstanding</span></button>
        <button className="kpi kpi-grey" onClick={() => setF({ ...EMPTY, status: 'awaiting_evidence' })}><span className="kpi-value">{count((v) => v.status === 'awaiting_evidence')}</span><span className="kpi-label">Awaiting evidence</span></button>
        <button className="kpi kpi-plain" onClick={() => setF({ ...EMPTY, status: 'complete' })}><span className="kpi-value">{count((v) => v.status === 'complete')}</span><span className="kpi-label">Ready to close</span></button>
        <button className="kpi kpi-green" onClick={() => setF({ ...EMPTY, status: 'closed' })}><span className="kpi-value">{count((v) => v.status === 'closed')}</span><span className="kpi-label">Closed</span></button>
        {count((v) => v.needs_review) > 0 && <button className="kpi kpi-red" onClick={() => setF({ ...EMPTY, status: '', review: true })}><span className="kpi-value">{count((v) => v.needs_review)}</span><span className="kpi-label">Need review</span></button>}
      </div>
      <div className="filters">
        <LocationSelects core={core} value={f} onChange={(v) => setF({ ...f, ...v })} />
        <select aria-label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          <option value="">All types</option>
          {core.types.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
        </select>
        <select aria-label="Visit status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="open">Not closed</option>
          <option value="">All statuses</option>
          {Object.entries(VISIT_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select aria-label="Remedial state" value={f.remedials} onChange={(e) => setF({ ...f, remedials: e.target.value })}>
          <option value="">Any remedials</option>
          <option value="open">Remedials open</option>
          <option value="done">All remedials done</option>
          <option value="none">No remedials</option>
        </select>
        <select aria-label="Evidence state" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })}>
          <option value="">Any evidence</option>
          <option value="missing">Required, not verified</option>
          <option value="verified">Required, verified</option>
          <option value="notreq">Not required</option>
        </select>
        <select aria-label="Responsible" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>
          <option value="">Anyone responsible</option>
          {core.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <label className="inline small">From <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="inline small">to <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <input type="search" placeholder="Search visit, activity, inspector…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <button className="btn-ghost" onClick={() => setF(EMPTY)}>Clear</button>
      </div>
      <Card>
        <DataTable cols={VISIT_COLS} rows={rows} onRowClick={(v) => navigate(`#/visits/${v.id}`)} empty="No visits match these filters" />
      </Card>
      {starting && <StartVisitModal onClose={() => setStarting(false)} />}
    </Page>
  );
}

// ---------- visit page ----------
type Answer = { response: string | null; notes: string };

export function VisitDetail({ id }: { id: number }) {
  const { data: v, error, reload, setData } = useLoad<Row>(`/api/visits/${id}`);
  const { data: core } = useLoad<Core>('/api/core');
  const { data: acts } = useLoad<Row[]>('/api/activities');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<Row | null>(null);
  const [metaDirty, setMetaDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [reopen, setReopen] = useState<'closure' | 'work' | null>(null);
  const [remedialFor, setRemedialFor] = useState<RemedialContext | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [linkTo, setLinkTo] = useState('');

  useEffect(() => {
    if (!v) return;
    setAnswers((cur) => {
      const next: Record<string, Answer> = Object.fromEntries(v.questions.map((q: Row) => [q.code, { response: q.response, notes: q.notes ?? '' }]));
      for (const code of dirty) if (cur[code]) next[code] = cur[code]; // keep unsaved edits across refreshes
      return next;
    });
    if (!metaDirty) setMeta({ performed_on: v.performed_on ?? '', inspector_user_id: String(v.inspector_user_id ?? ''), provider_name: v.provider_name, notes: v.notes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  // Evidence uploads / verification and remedial changes elsewhere on the page refresh the lifecycle.
  useEffect(() => {
    const f = () => reload();
    window.addEventListener('ph:changed', f);
    return () => window.removeEventListener('ph:changed', f);
  }, [reload]);
  const unsaved = dirty.size > 0 || metaDirty;
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => { if (unsaved) e.preventDefault(); };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [unsaved]);
  const answeredMandatory = useMemo(() => (v ? v.questions.filter((q: Row) => q.mandatory && answers[q.code]?.response).length : 0), [v, answers]);

  if (error) return <ErrorBox error={error} />;
  if (!v || !meta || !core) return <Loading />;
  const editable = v.status === 'in_progress';
  const closed = v.status === 'closed';
  const set = (code: string, patch: Partial<Answer>) => {
    setAnswers((a) => ({ ...a, [code]: { ...a[code], ...patch } }));
    setDirty((d) => new Set(d).add(code));
  };
  const save = async (): Promise<Row | null> => {
    setErr(null);
    setBusy(true);
    try {
      let fresh = v;
      if (metaDirty) fresh = await api.put(`/api/visits/${id}`, { ...meta, inspector_user_id: meta.inspector_user_id || null });
      if (dirty.size) fresh = await api.put(`/api/visits/${id}/answers`, { answers: [...dirty].map((c) => ({ item_code: c, ...answers[c] })) });
      setDirty(new Set());
      setMetaDirty(false);
      setData(fresh);
      return fresh;
    } catch (e: any) {
      setErr(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<Row>, note: string) => {
    setErr(null);
    setMsg(null);
    try {
      setData(await fn());
      setMsg(note);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const raise = async (q?: Row) => {
    if ((q && dirty.has(q.code)) || metaDirty) { if (!(await save())) return; }
    setRemedialFor({
      visit_id: id, visit_ref: v.ref, site_id: v.site_id, room_id: v.room_id, owner_user_id: v.owner_user_id,
      question_code: q?.code, title: q ? (q.question.length > 80 ? `${q.question.slice(0, 77)}…` : q.question) : '', description: q ? answers[q.code]?.notes : '',
    });
  };
  const openRem = v.remedials.filter((r: Row) => r.state !== 'Done');
  const sameSiteActs = (acts ?? []).filter((a) => a.site_id === v.site_id);

  return (
    <Page
      crumbs={<><a href="#/visits">Inspections / Visits</a>{v.area_code && <> › <a href={`#/areas/${v.area_id}`}>{v.area_code}</a></>}{v.site_id && <> › <a href={`#/sites/${v.site_id}`}>{v.site_code} {v.site_name}</a></>}{v.room_code && <> › {v.room_code} {v.room_name}</>}</>}
      title={<>{v.ref} · {v.checklist_name || v.type_name || 'Inspection'} <VisitStatusTag s={v.status} /></>}
      actions={
        <>
          {unsaved && <span className="unsaved">● Unsaved changes</span>}
          {editable && <button onClick={async () => { if (await save()) setMsg('Saved.'); }} disabled={busy}>Save</button>}
          {editable && <button className="btn-primary btn-lg" disabled={busy || !v.activity_id} onClick={async () => { if (await save()) setCompleting(true); }}>Complete Inspection…</button>}
          {!editable && !closed && <button onClick={() => setReopen('work')}>Reopen work…</button>}
          {!editable && !closed && (
            <button className="btn-primary btn-lg" disabled={v.blockers.length > 0} title={v.blockers.map((b: Row) => b.message).join('\n')}
              onClick={() => act(() => api.post(`/api/visits/${id}/close`), 'Inspection closed. Click Recalculate Compliance to update the activity status.')}>Close Inspection</button>
          )}
          {closed && <button onClick={() => setReopen('closure')}>Reopen inspection…</button>}
        </>
      }
    >
      <div className="chain">
        <span className="chain-step">Compliance Activity {v.activity_id ? <a href={`#/activities/${v.activity_id}`}>{v.activity_ref}</a> : <span className="warn">not linked</span>} {v.activity_name && <span className="muted small">{v.activity_name}</span>}</span>
        <span className="chain-arrow">→</span>
        <span className="chain-step"><strong>Visit {v.ref}</strong> <VisitStatusTag s={v.status} /></span>
        <span className="chain-arrow">→</span>
        <span className="chain-step">Remedials: {v.remedial_count ? <span className={openRem.length ? 'warn' : 'ok'}>{openRem.length} open of {v.remedial_count}</span> : 'none'}</span>
      </div>
      {v.needs_review ? (
        <div className="error">
          <strong>Needs review:</strong> {v.review_note}
          <div className="filters">
            <select aria-label="Link to activity" value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
              <option value="">Choose an activity at {v.site_code}…</option>
              {sameSiteActs.map((a) => <option key={a.id} value={a.id}>{a.ref} {a.type_code} — {a.name}</option>)}
            </select>
            <button disabled={!linkTo} onClick={() => act(() => api.post(`/api/visits/${id}/link-activity`, { activity_id: Number(linkTo), reason: 'Linked after review' }), 'Linked to the activity. Schedule unchanged.')}>Link</button>
          </div>
        </div>
      ) : null}
      <ErrorBox error={err} />
      {msg && <div className="note ok-note">{msg}</div>}
      {!editable && !closed && v.blockers.length > 0 && (
        <div className="blockers" data-testid="blockers">
          <strong>Close is blocked:</strong>
          <ul>
            {v.blockers.map((b: Row) => (
              <li key={b.code}>{b.message}{b.items && <> — {b.items.map((x: Row, i: number) => <span key={x.id}>{i > 0 && ', '}<a href={`#/remedials/${x.id}`}>{x.ref}</a> ({x.priority}, {x.state})</span>)}</>}</li>
            ))}
          </ul>
        </div>
      )}
      {!editable && !closed && v.blockers.length === 0 && <div className="note">All closure conditions are met. Click <strong>Close Inspection</strong>.</div>}

      <div className="grid2">
        <Card title="Visit details">
          {editable ? (
            <>
              <div className="grid2">
                <Field label="Visit / performed date"><input aria-label="Performed on" type="date" max={londonToday()} value={meta.performed_on} onChange={(e) => { setMeta({ ...meta, performed_on: e.target.value }); setMetaDirty(true); }} /></Field>
                <Field label="Inspector (staff)">
                  <select aria-label="Inspector" value={meta.inspector_user_id} onChange={(e) => { setMeta({ ...meta, inspector_user_id: e.target.value }); setMetaDirty(true); }}>
                    <option value="">— none —</option>
                    {core.users.filter((u) => u.active || String(u.id) === meta.inspector_user_id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Engineer / provider"><input aria-label="Provider" value={meta.provider_name} onChange={(e) => { setMeta({ ...meta, provider_name: e.target.value }); setMetaDirty(true); }} /></Field>
              <Field label="Notes"><textarea aria-label="Visit notes" rows={2} value={meta.notes} onChange={(e) => { setMeta({ ...meta, notes: e.target.value }); setMetaDirty(true); }} /></Field>
            </>
          ) : (
            <dl className="dl">
              <div><dt>Performed</dt><dd>{fmtDate(v.performed_on)}</dd></div>
              <div><dt>Inspector / provider</dt><dd>{[v.inspector_user_name, v.provider_name].filter(Boolean).join(' · ') || '—'}</dd></div>
              <div><dt>Notes</dt><dd>{v.notes || '—'}</dd></div>
            </dl>
          )}
        </Card>
        <Card title="Outcome & closure">
          <dl className="dl">
            <div><dt>Work outcome</dt><dd>{v.outcome_label ?? <span className="muted">Not yet recorded</span>}</dd></div>
            <div><dt>Status</dt><dd><VisitStatusTag s={v.status} /></dd></div>
            <div><dt>Work completed</dt><dd>{fmtStamp(v.completed_at)}</dd></div>
            <div><dt>Closed</dt><dd>{fmtStamp(v.closed_at)}</dd></div>
            <div><dt>Next due set</dt><dd>{v.next_due_set ? <>{fmtDate(v.next_due_set)}{v.next_due_override ? <span className="override-tag">Override</span> : null}{v.next_due_override ? <div className="muted small">{v.override_reason}</div> : null}</> : '—'}</dd></div>
            <div><dt>Evidence</dt><dd>{v.evidence_required ? <>{v.type_code} requires verified paperwork: {v.verified_doc_count ? <span className="ok">✔ verified</span> : <span className="warn">{v.doc_count ? 'linked, not verified' : 'missing'}</span>}</> : <span className="muted">Not required for {v.type_code ?? 'this visit'}</span>}</dd></div>
            <div><dt>Checklist</dt><dd>{v.checklist_name ? `${v.checklist_name} v${v.checklist_version ?? '—'} (snapshot of ${v.question_count} questions)` : '—'}</dd></div>
          </dl>
          <p className="muted small">Completing records the work and updates the activity's schedule. It does not make the activity compliant: RAG status changes only at Recalculate.</p>
        </Card>
      </div>

      {v.question_count > 0 && (
        <Card title={<>Checklist <span className="muted small">{answeredMandatory}/{v.mandatory_count} mandatory answered</span></>}
          actions={editable && v.unanswered.length > 0 && <label className="inline small"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Unanswered only</label>}>
          {v.sections.map((sec: string) => {
            const qs = v.questions.filter((q: Row) => q.section === sec && (!onlyOpen || !answers[q.code]?.response));
            if (!qs.length) return null;
            return (
              <div key={sec}>
                {v.sections.length > 1 && <h3>{sec}</h3>}
                <div className="questions">
                  {qs.map((q: Row) => {
                    const a = answers[q.code] ?? { response: null, notes: '' };
                    return (
                      <div key={q.code} id={`q-${q.code}`} className={`question ${a.response ? `q-${RESP_CLASS[a.response]}` : 'q-open'}`}>
                        <div className="q-text"><span className="muted small">{q.code}</span> {q.question} {q.mandatory ? '' : <span className="muted small">(optional)</span>}</div>
                        <div className="q-controls">
                          <div className="seg" role="radiogroup" aria-label={`${q.code} response`}>
                            {RESPONSES.map((r) => (
                              <button key={r} role="radio" aria-checked={a.response === r} disabled={!editable} className={`seg-btn ${a.response === r ? `on resp-${RESP_CLASS[r]}` : ''}`}
                                onClick={() => set(q.code, a.response === r && !q.remedials.length ? { response: null, notes: '' } : { response: r })}>{r}</button>
                            ))}
                          </div>
                          {editable ? <input className="q-notes" aria-label={`${q.code} notes`} placeholder={a.response === 'Issue' ? 'Describe the issue…' : 'Notes (optional)'} value={a.notes} disabled={!a.response} onChange={(e) => set(q.code, { notes: e.target.value })} />
                            : a.notes ? <span className="q-notes-ro">{a.notes}</span> : null}
                        </div>
                        {(a.response === 'Issue' || q.remedials.length > 0) && (
                          <div className="q-actions">
                            {q.remedials.map((x: Row) => <a key={x.id} href={`#/remedials/${x.id}`} className="action-chip">{x.ref} · {x.priority} · {x.state}</a>)}
                            {a.response === 'Issue' && !closed && <button className="small" onClick={() => raise(q)}>+ Raise remedial</button>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <Card title={<>Remedials <span className="muted small">{v.remedial_count} total · {openRem.length} open · {v.remedial_count - openRem.length} done</span></>}
        actions={!closed && <button onClick={() => raise()}>+ Raise remedial</button>}>
        <DataTable cols={REMEDIAL_COLS.filter((c) => !['visit_ref', 'activity_ref', 'loc'].includes(c.key))} rows={v.remedials} onRowClick={(x) => navigate(`#/remedials/${x.id}`)} empty="No remedials" />
        <p className="muted small">An inspection with outstanding remedials cannot be closed. When the last remedial is Done the inspection closes automatically if no paperwork is outstanding; otherwise it moves to Awaiting Evidence.</p>
      </Card>

      <DocumentsPanel kind="inspection" id={id} title={v.evidence_required ? 'Evidence documents (required: link and mark Reviewed/Verified)' : 'Supporting documents (optional)'} locked={closed} />

      <Card title="Timeline">
        <ul className="timeline">
          {v.events.map((e: Row) => <li key={e.id}><span className="muted small">{fmtStamp(e.at)}</span> <strong>{e.event.replace(/_/g, ' ')}</strong> {e.detail}{e.reason && <em> — reason: {e.reason}</em>}</li>)}
        </ul>
      </Card>

      {completing && <CompleteModal v={v} onClose={() => setCompleting(false)} onDone={(fresh) => { setCompleting(false); setData(fresh); setMsg('Work recorded and the activity schedule updated. Changes pending — click Recalculate Compliance to update status.'); }} />}
      {reopen && (
        <ReasonModal title={reopen === 'closure' ? `Reopen ${v.ref}` : `Reopen work on ${v.ref}`}
          help={reopen === 'closure' ? 'The closure date is cleared; evidence and history are kept.' : 'The visit returns to In Progress. If it set the activity schedule, the previous schedule is restored.'}
          onClose={() => setReopen(null)}
          onSubmit={async (reason) => { await act(() => api.post(`/api/visits/${id}/reopen`, { scope: reopen, reason }), 'Reopened. The reason is recorded in the timeline.'); setReopen(null); }} />
      )}
      {remedialFor && <RemedialModal context={remedialFor} onClose={() => setRemedialFor(null)} onSaved={() => { setRemedialFor(null); setMsg('Remedial raised.'); reload(); }} />}
    </Page>
  );
}

function CompleteModal({ v, onClose, onDone }: { v: Row; onClose: () => void; onDone: (fresh: Row) => void }) {
  const hasRemedials = v.remedials.length > 0;
  const [f, setF] = useState<Row>({ outcome: hasRemedials ? 'complete_remedials' : 'complete', next_due_override: false, next_due_on: '', override_reason: '' });
  const [err, setErr] = useState<string | null>(null);
  const proposed = v.performed_on && v.interval_months ? addMonths(v.performed_on, v.interval_months) : null;
  return (
    <Modal title={`Complete ${v.ref}`} onClose={onClose}>
      <ErrorBox error={err} />
      <Field label="Work outcome">
        <label className="inline"><input type="radio" name="outcome" checked={f.outcome === 'complete'} onChange={() => setF({ ...f, outcome: 'complete' })} /> Inspection Complete</label>
        <label className="inline"><input type="radio" name="outcome" checked={f.outcome === 'complete_remedials'} onChange={() => setF({ ...f, outcome: 'complete_remedials' })} /> Inspection Complete with Remedials</label>
      </Field>
      <p className="muted small">{hasRemedials ? `${v.remedials.filter((r: Row) => r.state !== 'Done').length} remedial(s) open.` : 'No remedials raised.'} Performed {fmtDate(v.performed_on)}.</p>
      <div className={`calc-due ${f.next_due_override ? 'superseded' : ''}`} data-testid="proposed-next-due">
        Proposed next due: <strong>{proposed ? fmtDate(proposed) : '—'}</strong> <span className="muted small">{proposed ? `(${fmtDate(v.performed_on)} + ${v.interval_months} months)` : '(no interval: use an override)'}</span>
      </div>
      <label className="inline"><input type="checkbox" aria-label="Override proposed next due" checked={f.next_due_override} onChange={(e) => setF({ ...f, next_due_override: e.target.checked, next_due_on: e.target.checked ? (proposed ?? '') : '' })} /> Override the proposed date</label>
      {f.next_due_override && (
        <div className="grid2 override-fields">
          <Field label="Next due"><input aria-label="Override date" type="date" value={f.next_due_on} onChange={(e) => setF({ ...f, next_due_on: e.target.value })} /></Field>
          <Field label="Reason (required)"><input aria-label="Override reason" value={f.override_reason} onChange={(e) => setF({ ...f, override_reason: e.target.value })} /></Field>
        </div>
      )}
      <p className="muted small">Completing does not close the inspection or make the activity compliant. {v.evidence_required ? 'This type requires verified paperwork before closure.' : ''}</p>
      <div className="form-actions">
        <button className="btn-primary" onClick={async () => {
          setErr(null);
          try { onDone(await api.post(`/api/visits/${v.id}/complete`, f)); } catch (e: any) { setErr(e.message); }
        }}>Record {f.outcome === 'complete' ? 'Inspection Complete' : 'Complete with Remedials'}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

export function ReasonModal({ title, help, onClose, onSubmit }: { title: string; help: string; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted small">{help}</p>
      <Field label="Reason (required, recorded in the timeline)"><textarea aria-label="Reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="form-actions">
        <button className="btn-primary" disabled={!reason.trim()} onClick={() => onSubmit(reason.trim())}>Reopen</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---------- activity history (actual inspections first; calculation history separate) ----------
interface SnapGroup { id: string; first: string; last: string; count: number; status: string; due_on: string | null; reason: string }
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
const SCHED_SOURCE: Record<string, string> = { edit: 'Manual edit', visit: 'Visit completed', 'visit-reopen': 'Visit work reopened', 'type-interval': 'Type interval changed', migration: 'Upgrade' };

export function ActivityHistory({ a }: { a: Row }) {
  const { data } = useLoad<Row>(`/api/activities/${a.id}/history`);
  const [view, setView] = useState('visits');
  const [shown, setShown] = useState(10);
  const groups = useMemo(() => (data ? groupSnapshots(data.snapshots) : []), [data]);
  if (!data) return <Loading />;
  return (
    <>
      <Tabs
        active={view}
        onChange={setView}
        tabs={[
          { key: 'visits', label: 'Inspection history', count: data.visits.length },
          { key: 'schedule', label: 'Schedule changes', count: data.schedule.length },
          { key: 'calc', label: 'Calculation history', count: groups.length },
          { key: 'reminders', label: 'Reminders', count: data.emails.length },
        ]}
      />
      {view === 'visits' && (
        <Card title="Inspections / visits (latest first)">
          <DataTable cols={VISIT_COLS.filter((c) => c.key !== 'activity_ref' && c.key !== 'loc')} rows={data.visits} onRowClick={(v) => navigate(`#/visits/${v.id}`)} empty="No inspections recorded yet" />
          <p className="muted small">Each visit keeps the checklist questions and version it was performed with, its remedials and its evidence.</p>
        </Card>
      )}
      {view === 'schedule' && (
        <Card title="Schedule changes (traceable)">
          <DataTable
            rows={data.schedule}
            empty="No schedule changes recorded"
            cols={[
              { key: 'changed_at', label: 'When', render: (l) => fmtStamp(l.changed_at) },
              { key: 'source', label: 'Source', render: (l) => <>{SCHED_SOURCE[l.source] ?? l.source}{l.visit_ref ? ` (${l.visit_ref})` : ''}</> },
              { key: 'last', label: 'Last work performed', render: (l) => l.old_last_done === l.new_last_done ? fmtDate(l.new_last_done) : <>{fmtDate(l.old_last_done)} → <strong>{fmtDate(l.new_last_done)}</strong></> },
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
          <DataTable rows={data.emails} empty="No reminders sent or exported" cols={[
            { key: 'sent_at', label: 'When', render: (l) => fmtStamp(l.sent_at) },
            { key: 'mode', label: 'Mode' }, { key: 'outcome', label: 'Outcome' }, { key: 'recipient_email', label: 'Recipient' }, { key: 'subject', label: 'Subject' },
          ]} />
        </Card>
      )}
    </>
  );
}

export const VISIT_STATUS_OPTIONS = Object.entries(VISIT_STATUS);
export { STATUS_LABEL };
