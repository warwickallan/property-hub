import { useEffect, useMemo, useState } from 'react';
import { api, downloadCsv, type Core, type Row } from '../api';
import { Card, DataTable, DocumentsPanel, ErrorBox, Field, Loading, LocationSelects, Modal, Page, Tabs, useStoredState, type Col, type LocFilter } from '../components';
import { fmtDate, fmtDateTime, londonToday, navigate, useLoad } from '../util';
import { ACTION_COLS, ActionModal, type ActionContext } from './Actions';
import { ChecksRegister, StartChooser } from './Checks';

const RESPONSES = ['Pass', 'Issue', 'Not applicable', 'Not checked'];
const RESP_CLASS: Record<string, string> = { Pass: 'pass', Issue: 'issue', 'Not applicable': 'na', 'Not checked': 'nc' };

export function InspectionState({ s }: { s: string }) {
  return s === 'complete' ? <span className="state state-done">Completed</span> : <span className="state state-in-progress">Draft</span>;
}

function Progress({ answered, total, issues }: { answered: number; total: number; issues?: number }) {
  const pct = total ? Math.round((answered / total) * 100) : 0;
  return (
    <span className="progress" title={`${answered} of ${total} answered`}>
      <span className="progress-bar"><span style={{ width: `${pct}%` }} /></span>
      <span className="small">{answered}/{total}{issues ? <> · <span className="warn">{issues} issue{issues === 1 ? '' : 's'}</span></> : null}</span>
    </span>
  );
}

export const INSPECTION_COLS: Col[] = [
  { key: 'ref', label: 'Ref', render: (r) => <strong>{r.ref}</strong> },
  { key: 'inspected_on', label: 'Date', render: (r) => fmtDate(r.inspected_on) },
  { key: 'site_code', label: 'Site', render: (r) => `${r.site_code} ${r.site_name}` },
  { key: 'room_code', label: 'Scope', render: (r) => (r.room_code ? `${r.room_code} ${r.room_name}` : 'Whole site') },
  { key: 'inspector', label: 'Inspector', render: (r) => r.inspector ?? '—' },
  { key: 'state', label: 'Status', render: (r) => <InspectionState s={r.state} /> },
  { key: 'answered', label: 'Progress', render: (r) => <Progress answered={r.answered} total={r.question_count} issues={r.issues} /> },
  { key: 'open_actions', label: 'Open actions', className: 'num', render: (r) => r.open_actions || '—' },
];

// ---------- start ----------
export function StartInspectionModal({ siteId, roomId, onClose }: { siteId?: number; roomId?: number; onClose: () => void }) {
  const { data: core } = useLoad<Core>('/api/core');
  const [f, setF] = useState<Row>({ site_id: String(siteId ?? ''), room_id: String(roomId ?? ''), inspected_on: londonToday(), inspector_user_id: '', inspector_name: '', notes: '' });
  const [err, setErr] = useState<string | null>(null);
  if (!core) return <Modal title="Start inspection" onClose={onClose}><Loading /></Modal>;
  const start = async () => {
    setErr(null);
    try {
      const r = await api.post('/api/inspections', { ...f, room_id: f.room_id || null, inspector_user_id: f.inspector_user_id || null });
      navigate(`#/inspections/${r.id}`);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="Start routine inspection" onClose={onClose}>
      <ErrorBox error={err} />
      <p className="muted small">30-point visual inspection. It records what was observed; it is not a statutory certificate and does not change compliance status.</p>
      <Field label="Site">
        <select aria-label="Inspection site" value={f.site_id} onChange={(e) => setF({ ...f, site_id: e.target.value, room_id: '' })}>
          <option value="">Choose…</option>
          {core.sites.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
        </select>
      </Field>
      <Field label="Room (optional — leave blank for the whole site)">
        <select aria-label="Inspection room" value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value })}>
          <option value="">— whole site —</option>
          {core.rooms.filter((r) => String(r.site_id) === f.site_id).map((r) => <option key={r.id} value={r.id}>{r.code} {r.name}</option>)}
        </select>
      </Field>
      <Field label="Inspection date"><input aria-label="Inspection date" type="date" value={f.inspected_on} onChange={(e) => setF({ ...f, inspected_on: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="Inspector">
          <select aria-label="Inspector" value={f.inspector_user_id} onChange={(e) => setF({ ...f, inspector_user_id: e.target.value })}>
            <option value="">— type a name instead —</option>
            {core.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        {!f.inspector_user_id && <Field label="Inspector name"><input aria-label="Inspector name" value={f.inspector_name} onChange={(e) => setF({ ...f, inspector_name: e.target.value })} /></Field>}
      </div>
      <div className="form-actions">
        <button className="btn-primary" onClick={start}>Start inspection</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---------- register ----------
interface Filters extends LocFilter { state: string; from: string; to: string; q: string }
const EMPTY: Filters = { area: '', site: '', room: '', state: '', from: '', to: '', q: '' };

export function Inspections() {
  const { data: core } = useLoad<Core>('/api/core');
  const { data, error } = useLoad<Row[]>('/api/inspections');
  const [f, setF] = useStoredState<Filters>('ph:insp', EMPTY);
  const [starting, setStarting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [mode, setMode] = useStoredState('ph:inspmode', { tab: 'routine' });
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data || !core) return <Loading />;
  const q = f.q.toLowerCase();
  const rows = data.filter((r) =>
    (!f.area || String(r.area_id) === f.area) && (!f.site || String(r.site_id) === f.site) && (!f.room || String(r.room_id) === f.room) &&
    (!f.state || r.state === f.state) && (!f.from || r.inspected_on >= f.from) && (!f.to || r.inspected_on <= f.to) &&
    (!q || `${r.ref} ${r.site_code} ${r.site_name} ${r.room_name ?? ''} ${r.inspector ?? ''} ${r.notes}`.toLowerCase().includes(q)));
  const completed = rows.filter((r) => r.state === 'complete');
  return (
    <Page
      title="Inspections"
      actions={
        <>
          <button disabled={!completed.length} onClick={async () => {
            setErr(null);
            try { await downloadCsv('/api/export/inspections', { ids: completed.map((r) => r.id) }, 'inspection-results.csv'); } catch (e: any) { setErr(e.message); }
          }}>Export completed results CSV ({completed.length})</button>
          <button className="btn-primary" onClick={() => setChoosing(true)}>+ Start inspection</button>
        </>
      }
    >
      <ErrorBox error={err} />
      <Tabs
        active={mode.tab}
        onChange={(tab) => setMode({ tab })}
        tabs={[
          { key: 'routine', label: 'Routine Property Inspections', count: data.length },
          { key: 'checks', label: 'Compliance Inspections / Checks' },
        ]}
      />
      {mode.tab === 'checks' ? <ChecksRegister /> : <>
      <p className="muted small">Routine 30-point visual inspections. They record observations and raise remedial actions; they do not count as statutory evidence.</p>
      <div className="filters">
        <LocationSelects core={core} value={f} onChange={(v) => setF({ ...f, ...v })} />
        <select aria-label="Inspection status" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
          <option value="">Drafts & completed</option>
          <option value="draft">Drafts</option>
          <option value="complete">Completed</option>
        </select>
        <label className="inline small">From <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="inline small">to <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <input type="search" placeholder="Search ref, site, inspector…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <button className="btn-ghost" onClick={() => setF(EMPTY)}>Clear</button>
      </div>
      <Card>
        <DataTable cols={INSPECTION_COLS} rows={rows} onRowClick={(r) => navigate(`#/inspections/${r.id}`)} empty="No inspections match" />
      </Card>
      </>}
      {choosing && <StartChooser onClose={() => setChoosing(false)} onRoutine={() => { setChoosing(false); setStarting(true); }} />}
      {starting && <StartInspectionModal onClose={() => setStarting(false)} />}
    </Page>
  );
}

// ---------- detail / form ----------
type Answer = { response: string | null; notes: string };

export function InspectionDetail({ id }: { id: number }) {
  const { data: run, error, reload, setData } = useLoad<Row>(`/api/inspections/${id}`);
  const { data: core } = useLoad<Core>('/api/core');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<Row | null>(null);
  const [metaDirty, setMetaDirty] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionFor, setActionFor] = useState<ActionContext | null>(null);

  useEffect(() => {
    if (!run) return;
    setAnswers(Object.fromEntries(run.questions.map((q: Row) => [q.code, { response: q.response, notes: q.notes ?? '' }])));
    setDirty(new Set());
    setMeta({ inspected_on: run.inspected_on, inspector_user_id: String(run.inspector_user_id ?? ''), inspector_name: run.inspector_name, room_id: String(run.room_id ?? ''), notes: run.notes });
    setMetaDirty(false);
  }, [run]);

  const unsaved = dirty.size > 0 || metaDirty;
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => { if (unsaved) e.preventDefault(); };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [unsaved]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { answered: 0, Pass: 0, Issue: 0, 'Not applicable': 0, 'Not checked': 0 };
    for (const a of Object.values(answers)) if (a.response) { c.answered++; c[a.response]++; }
    return c;
  }, [answers]);

  if (error) return <ErrorBox error={error} />;
  if (!run || !meta || !core) return <Loading />;
  const draft = run.state === 'draft';
  const total = run.questions.length;
  const unanswered = run.questions.filter((q: Row) => !answers[q.code]?.response).map((q: Row) => q.code);

  const set = (code: string, patch: Partial<Answer>) => {
    setAnswers((a) => ({ ...a, [code]: { ...a[code], ...patch } }));
    setDirty((d) => new Set(d).add(code));
  };

  /** Persist meta + changed answers. Returns the fresh run or null on error. */
  const save = async (): Promise<Row | null> => {
    setErr(null);
    setBusy(true);
    try {
      let fresh: Row = run;
      if (metaDirty) {
        fresh = await api.put(`/api/inspections/${id}`, { ...meta, room_id: meta.room_id || null, inspector_user_id: meta.inspector_user_id || null });
      }
      if (dirty.size) {
        fresh = await api.put(`/api/inspections/${id}/answers`, { answers: [...dirty].map((code) => ({ question_code: code, ...answers[code] })) });
      }
      setData(fresh);
      return fresh;
    } catch (e: any) {
      setErr(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!(await save())) return;
    try {
      setData(await api.post(`/api/inspections/${id}/complete`));
      setMsg('Inspection completed. Results are now read-only; reopen to correct them.');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const raiseAction = async (q: Row) => {
    const fresh = dirty.has(q.code) || metaDirty ? await save() : run;
    if (!fresh) return;
    const a = answers[q.code];
    setActionFor({
      inspection_run_id: id, question_code: q.code, site_id: run.site_id, room_id: run.room_id,
      title: q.question.length > 80 ? `${q.question.slice(0, 77)}…` : q.question, description: a.notes, owner_user_id: run.inspector_user_id,
    });
  };

  const groupRows = (g: string) => run.questions.filter((q: Row) => q.group_name === g);
  return (
    <Page
      crumbs={<><a href="#/inspections">Inspections</a> › <a href={`#/areas/${run.area_id}`}>{run.area_code}</a> › <a href={`#/sites/${run.site_id}`}>{run.site_code} {run.site_name}</a>{run.room_id && <> › <a href={`#/rooms/${run.room_id}`}>{run.room_code} {run.room_name}</a></>}</>}
      title={<>{run.ref} · Routine inspection <InspectionState s={run.state} /></>}
      actions={
        draft ? (
          <>
            {unsaved && <span className="unsaved">● Unsaved changes</span>}
            <button onClick={async () => { if (await save()) setMsg('Draft saved. You can resume it later from Inspections.'); }} disabled={busy}>Save draft</button>
            <button className="btn-primary" onClick={complete} disabled={busy}>Complete inspection</button>
          </>
        ) : (
          <>
            <button onClick={() => downloadCsv('/api/export/inspections', { ids: [id] }, `${run.ref}-results.csv`).catch((e) => setErr(e.message))}>Export results CSV</button>
            <button onClick={async () => { try { setData(await api.post(`/api/inspections/${id}/reopen`)); setMsg('Reopened as draft.'); } catch (e: any) { setErr(e.message); } }}>Reopen for correction</button>
          </>
        )
      }
    >
      <div className="note">Routine visual inspection ({run.template_code} v{run.template_version}). It is <strong>not</strong> a statutory compliance certificate and does not change any compliance status.</div>
      <ErrorBox error={err} />
      {msg && <div className="note ok-note">{msg}</div>}

      <div className="grid2">
        <Card title="Inspection details">
          {draft ? (
            <>
              <div className="grid2">
                <Field label="Date"><input type="date" value={meta.inspected_on} onChange={(e) => { setMeta({ ...meta, inspected_on: e.target.value }); setMetaDirty(true); }} /></Field>
                <Field label="Room (optional)">
                  <select value={meta.room_id} onChange={(e) => { setMeta({ ...meta, room_id: e.target.value }); setMetaDirty(true); }}>
                    <option value="">— whole site —</option>
                    {core.rooms.filter((r) => r.site_id === run.site_id).map((r) => <option key={r.id} value={r.id}>{r.code} {r.name}</option>)}
                  </select>
                </Field>
              </div>
              <div className="grid2">
                <Field label="Inspector">
                  <select value={meta.inspector_user_id} onChange={(e) => { setMeta({ ...meta, inspector_user_id: e.target.value }); setMetaDirty(true); }}>
                    <option value="">— named below —</option>
                    {core.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </Field>
                {!meta.inspector_user_id && <Field label="Inspector name"><input value={meta.inspector_name} onChange={(e) => { setMeta({ ...meta, inspector_name: e.target.value }); setMetaDirty(true); }} /></Field>}
              </div>
              <Field label="General notes"><textarea rows={2} value={meta.notes} onChange={(e) => { setMeta({ ...meta, notes: e.target.value }); setMetaDirty(true); }} /></Field>
            </>
          ) : (
            <dl className="dl">
              <div><dt>Date</dt><dd>{fmtDate(run.inspected_on)}</dd></div>
              <div><dt>Scope</dt><dd>{run.site_code} {run.site_name}{run.room_code ? ` › ${run.room_code} ${run.room_name}` : ' (whole site)'}</dd></div>
              <div><dt>Inspector</dt><dd>{run.inspector}</dd></div>
              <div><dt>Completed</dt><dd>{fmtDateTime(run.completed_at)}</dd></div>
              <div><dt>Notes</dt><dd>{run.notes || '—'}</dd></div>
            </dl>
          )}
        </Card>
        <Card title="Progress">
          <Progress answered={counts.answered} total={total} />
          <div className="resp-counts">
            {RESPONSES.map((r) => <span key={r} className={`resp-count resp-${RESP_CLASS[r]}`}>{r}: <strong>{counts[r]}</strong></span>)}
          </div>
          {unanswered.length > 0 ? (
            <>
              <p className="small"><strong>{unanswered.length} outstanding:</strong> {unanswered.map((c: string, i: number) => <span key={c}>{i > 0 && ', '}<a href={`#q-${c}`} onClick={(e) => { e.preventDefault(); document.getElementById(`q-${c}`)?.scrollIntoView({ block: 'center' }); }}>{c}</a></span>)}</p>
              <label className="inline small"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Show unanswered questions only</label>
            </>
          ) : <p className="ok small">All {total} questions answered{draft ? ' — ready to complete.' : '.'}</p>}
        </Card>
      </div>

      {run.groups.map((g: string) => {
        const qs = groupRows(g).filter((q: Row) => !onlyOpen || !answers[q.code]?.response);
        if (!qs.length) return null;
        const done = groupRows(g).filter((q: Row) => answers[q.code]?.response).length;
        return (
          <Card key={g} title={<>{g} <span className="muted small">{done}/{groupRows(g).length}</span></>}>
            <div className="questions">
              {qs.map((q: Row) => {
                const a = answers[q.code] ?? { response: null, notes: '' };
                const savedIssue = q.response === 'Issue' && !dirty.has(q.code);
                return (
                  <div key={q.code} id={`q-${q.code}`} className={`question ${a.response ? `q-${RESP_CLASS[a.response]}` : 'q-open'}`}>
                    <div className="q-text"><span className="muted small">{q.code}</span> {q.question}</div>
                    <div className="q-controls">
                      <div className="seg" role="radiogroup" aria-label={`${q.code} response`}>
                        {RESPONSES.map((r) => (
                          <button key={r} role="radio" aria-checked={a.response === r} disabled={!draft}
                            className={`seg-btn ${a.response === r ? `on resp-${RESP_CLASS[r]}` : ''}`}
                            onClick={() => set(q.code, a.response === r && !q.actions.length ? { response: null, notes: '' } : { response: r })}>{r}</button>
                        ))}
                      </div>
                      {draft ? (
                        <input className="q-notes" aria-label={`${q.code} notes`} placeholder={a.response === 'Issue' ? 'Describe the issue…' : 'Notes (optional)'} value={a.notes}
                          disabled={!a.response} onChange={(e) => set(q.code, { notes: e.target.value })} />
                      ) : a.notes ? <span className="q-notes-ro">{a.notes}</span> : null}
                    </div>
                    {(a.response === 'Issue' || q.actions.length > 0) && (
                      <div className="q-actions">
                        {q.actions.map((x: Row) => (
                          <a key={x.id} href={`#/actions/${x.id}`} className="action-chip">{x.ref} · {x.priority} · {x.state}</a>
                        ))}
                        {a.response === 'Issue' && (
                          <button className="small" onClick={() => raiseAction(q)} title={savedIssue ? '' : 'Saves this answer first'}>+ Create remedial action</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      <Card title={`Remedial actions from this inspection (${run.actions.length})`}>
        <DataTable cols={ACTION_COLS} rows={run.actions} onRowClick={(x) => navigate(`#/actions/${x.id}`)} empty="None raised" />
      </Card>
      <DocumentsPanel kind="inspection" id={id} title="Supplementary evidence (photos, notes)" />
      {draft && (
        <div className="form-actions sticky-actions">
          {unsaved && <span className="unsaved">● Unsaved changes</span>}
          <button onClick={async () => { if (await save()) setMsg('Draft saved.'); }} disabled={busy}>Save draft</button>
          <button className="btn-primary" onClick={complete} disabled={busy}>Complete inspection</button>
          <button className="btn-ghost" onClick={async () => {
            if (!confirm('Delete this draft inspection?')) return;
            try { await api.del(`/api/inspections/${id}`); navigate('#/inspections'); } catch (e: any) { setErr(e.message); }
          }}>Delete draft</button>
        </div>
      )}
      {actionFor && (
        <ActionModal context={actionFor} onClose={() => setActionFor(null)} onSaved={() => { setActionFor(null); setMsg('Remedial action created.'); reload(); }} />
      )}
    </Page>
  );
}
