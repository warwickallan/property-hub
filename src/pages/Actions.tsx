// Remedials (formerly "Actions"). Every new remedial is raised from an Inspection / Visit.
import { useEffect, useState } from 'react';
import { api, downloadCsv, type Core, type Row } from '../api';
import { Card, DataTable, DocumentsPanel, ErrorBox, Field, Loading, LocationSelects, Modal, Page, useStoredState, type Col, type LocFilter } from '../components';
import { fmtDate, navigate, useLoad } from '../util';

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
export const STATES = ['Open', 'In progress', 'Done'];

export function PriorityTag({ p }: { p: string }) {
  return <span className={`prio prio-${p.toLowerCase()}`}>{p}</span>;
}
export function StateTag({ s, overdue }: { s: string; overdue?: boolean }) {
  return (
    <>
      <span className={`state state-${s.replace(' ', '-').toLowerCase()}`}>{s}</span>
      {overdue && <span className="state state-overdue">Overdue</span>}
    </>
  );
}

export const REMEDIAL_COLS: Col[] = [
  { key: 'ref', label: 'Ref', render: (x) => <strong>{x.ref}</strong> },
  { key: 'title', label: 'Remedial', render: (x) => <>{x.title}{x.question_code && <div className="muted small">{x.question_code}</div>}</> },
  { key: 'priority', label: 'Priority', render: (x) => <PriorityTag p={x.priority} />, sort: (x) => PRIORITIES.indexOf(x.priority) },
  { key: 'state', label: 'Status', render: (x) => <StateTag s={x.state} overdue={x.overdue} />, sort: (x) => STATES.indexOf(x.state) },
  { key: 'due_on', label: 'Due', render: (x) => fmtDate(x.due_on) },
  { key: 'owner_name', label: 'Owner', render: (x) => x.owner_name ?? '—' },
  { key: 'loc', label: 'Location', render: (x) => [x.area_code, x.site_code, x.room_code, x.equipment_code].filter(Boolean).join(' › ') || '—', sort: (x) => `${x.site_code ?? ''}${x.room_code ?? ''}` },
  { key: 'visit_ref', label: 'Inspection', render: (x) => (x.visit_ref ? <>{x.visit_ref}<div className="muted small">{x.visit_status_label}</div></> : <span className="warn">No visit (review)</span>) },
  { key: 'activity_ref', label: 'Activity', render: (x) => x.activity_ref ?? '—' },
];

// ---------- raise a remedial (always from a visit) ----------
export interface RemedialContext {
  visit_id: number;
  visit_ref: string;
  site_id?: number | null;
  room_id?: number | null;
  owner_user_id?: number | null;
  question_code?: string;
  title?: string;
  description?: string;
}

export function RemedialModal({ context, onClose, onSaved }: { context: RemedialContext; onClose: () => void; onSaved: (a: Row) => void }) {
  const { data: core } = useLoad<Core>('/api/core');
  const [f, setF] = useState<Row>({
    title: context.title ?? '', description: context.description ?? '', priority: 'Medium', owner_user_id: String(context.owner_user_id ?? ''),
    due_on: '', room_id: String(context.room_id ?? ''), equipment_id: '', notes: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!core) return <Modal title="Raise remedial" onClose={onClose}><Loading /></Modal>;
  const u = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const rooms = core.rooms.filter((r) => !context.site_id || r.site_id === context.site_id);
  const equipment = core.equipment.filter((e) => (f.room_id ? String(e.room_id) === f.room_id : rooms.some((r) => r.id === e.room_id)));
  const save = async () => {
    setErr(null);
    setSaving(true);
    try {
      onSaved(await api.post('/api/actions', {
        visit_id: context.visit_id, question_code: context.question_code ?? null, title: f.title, description: f.description, priority: f.priority,
        owner_user_id: f.owner_user_id || null, due_on: f.due_on || null, room_id: f.room_id || null, equipment_id: f.equipment_id || null, notes: f.notes,
      }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={`Raise remedial on ${context.visit_ref}${context.question_code ? ` (${context.question_code})` : ''}`} onClose={onClose}>
      <ErrorBox error={err} />
      <Field label="Title"><input aria-label="Remedial title" value={f.title} onChange={u('title')} /></Field>
      <Field label="Description"><textarea aria-label="Remedial description" rows={3} value={f.description} onChange={u('description')} /></Field>
      <div className="grid2">
        <Field label="Priority">
          <select aria-label="Remedial priority" value={f.priority} onChange={u('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
        </Field>
        <Field label="Due date"><input aria-label="Remedial due" type="date" value={f.due_on} onChange={u('due_on')} /></Field>
      </div>
      {f.priority === 'Critical' && <div className="note">An open <strong>Critical</strong> remedial turns this inspection's Compliance Activity <strong>red at the next Recalculate</strong>.</div>}
      <Field label="Owner / contact">
        <select aria-label="Remedial owner" value={f.owner_user_id} onChange={u('owner_user_id')}>
          <option value="">— none —</option>
          {core.users.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.role_label})</option>)}
        </select>
      </Field>
      <div className="grid2">
        <Field label="Room (optional)">
          <select aria-label="Remedial room" value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value, equipment_id: '' })}>
            <option value="">— whole site —</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} {r.name}</option>)}
          </select>
        </Field>
        <Field label="Equipment (optional)">
          <select aria-label="Remedial equipment" value={f.equipment_id} onChange={u('equipment_id')}>
            <option value="">— none —</option>
            {equipment.map((e) => <option key={e.id} value={e.id}>{e.asset_code} {e.description}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Notes"><textarea rows={2} value={f.notes} onChange={u('notes')} /></Field>
      <div className="form-actions">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Raise remedial'}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---------- register ----------
interface Filters extends LocFilter { state: string; priority: string; owner: string; overdue: boolean; dueBy: string; q: string }
const EMPTY: Filters = { area: '', site: '', room: '', state: 'active', priority: '', owner: '', overdue: false, dueBy: '', q: '' };

export function RemedialsRegister() {
  const { data: core } = useLoad<Core>('/api/core');
  const { data, error } = useLoad<Row[]>('/api/actions');
  const [f, setF] = useStoredState<Filters>('ph:remedials', EMPTY);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data || !core) return <Loading />;
  const q = f.q.toLowerCase();
  const rows = data.filter((x) =>
    (!f.area || String(x.area_id) === f.area) && (!f.site || String(x.site_id) === f.site) && (!f.room || String(x.room_id) === f.room) &&
    (f.state === 'active' ? x.state !== 'Done' : !f.state || x.state === f.state) && (!f.priority || x.priority === f.priority) &&
    (!f.owner || String(x.owner_user_id ?? '') === f.owner) && (!f.overdue || x.overdue) && (!f.dueBy || (x.due_on && x.due_on <= f.dueBy)) &&
    (!q || `${x.ref} ${x.title} ${x.description} ${x.activity_ref ?? ''} ${x.visit_ref ?? ''} ${x.site_code ?? ''} ${x.site_name ?? ''} ${x.owner_name ?? ''}`.toLowerCase().includes(q)));
  const count = (pred: (x: Row) => boolean) => data.filter(pred).length;
  return (
    <Page
      title="Remedials"
      actions={<button onClick={async () => {
        setErr(null);
        try { await downloadCsv('/api/export/actions', { ids: rows.map((r) => r.id) }, 'remedials.csv'); } catch (e: any) { setErr(e.message); }
      }}>Export CSV ({rows.length})</button>}
    >
      <p className="muted small">Remedials are raised from an Inspection / Visit (open the visit and use <em>Raise remedial</em>). Each one belongs to that visit and its Compliance Activity.</p>
      <ErrorBox error={err} />
      <div className="kpis">
        <button className="kpi kpi-plain" onClick={() => setF({ ...EMPTY, state: 'active' })}><span className="kpi-value">{count((x) => x.state !== 'Done')}</span><span className="kpi-label">Open + in progress</span></button>
        <button className="kpi kpi-red" onClick={() => setF({ ...EMPTY, state: 'active', priority: 'Critical' })}><span className="kpi-value">{count((x) => x.state !== 'Done' && x.priority === 'Critical')}</span><span className="kpi-label">Critical open</span></button>
        <button className="kpi kpi-amber" onClick={() => setF({ ...EMPTY, state: 'active', overdue: true })}><span className="kpi-value">{count((x) => x.overdue)}</span><span className="kpi-label">Overdue</span></button>
        <button className="kpi kpi-green" onClick={() => setF({ ...EMPTY, state: 'Done' })}><span className="kpi-value">{count((x) => x.state === 'Done')}</span><span className="kpi-label">Done</span></button>
      </div>
      <div className="filters">
        <LocationSelects core={core} value={f} onChange={(v) => setF({ ...f, ...v })} />
        <select aria-label="Status" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
          <option value="active">Open + in progress</option>
          <option value="">All statuses</option>
          {STATES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select aria-label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
          <option value="">All priorities</option>
          {PRIORITIES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select aria-label="Owner" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>
          <option value="">Any owner</option>
          {core.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <label className="inline small"><input type="checkbox" checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked })} /> Overdue only</label>
        <label className="inline small">Due by <input type="date" value={f.dueBy} onChange={(e) => setF({ ...f, dueBy: e.target.value })} /></label>
        <input type="search" placeholder="Search ref, title, visit, site…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <button className="btn-ghost" onClick={() => setF(EMPTY)}>Clear</button>
      </div>
      <Card>
        <DataTable cols={REMEDIAL_COLS} rows={rows} onRowClick={(x) => navigate(`#/remedials/${x.id}`)} empty="No remedials match these filters" />
      </Card>
    </Page>
  );
}

// ---------- detail ----------
export function RemedialDetail({ id }: { id: number }) {
  const { data: a, error, reload } = useLoad<Row>(`/api/actions/${id}`);
  const { data: core } = useLoad<Core>('/api/core');
  const [f, setF] = useState<Row | null>(null);
  const [closing, setClosing] = useState(false);
  const [closure, setClosure] = useState({ closure_notes: '', closed_on: '' });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (a) setF({ title: a.title, description: a.description, priority: a.priority, owner_user_id: String(a.owner_user_id ?? ''), due_on: a.due_on ?? '', notes: a.notes, room_id: String(a.room_id ?? ''), equipment_id: String(a.equipment_id ?? '') });
  }, [a]);
  if (error) return <ErrorBox error={error} />;
  if (!a || !f || !core) return <Loading />;
  const locked = a.visit_status === 'closed';
  const put = async (body: Row, note: string) => {
    setErr(null);
    setMsg(null);
    try {
      const r = await api.put(`/api/actions/${id}`, body);
      const v = r.visit_id ? await api.get(`/api/visits/${r.visit_id}`) : null;
      setMsg(`${note}${v ? ` Inspection ${v.ref} is now: ${v.status_label}.` : ''}`);
      reload();
      return true;
    } catch (e: any) {
      setErr(e.message);
      return false;
    }
  };
  const u = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const rooms = core.rooms.filter((r) => r.site_id === a.site_id);
  return (
    <Page
      crumbs={<><a href="#/remedials">Remedials</a>{a.visit_id && <> › <a href={`#/visits/${a.visit_id}`}>{a.visit_ref}</a></>}</>}
      title={<>{a.ref} · {a.title}</>}
      actions={!locked && (
        <>
          {a.state === 'Open' && <button onClick={() => put({ state: 'In progress' }, 'Marked In progress.')}>Start (In progress)</button>}
          {a.state !== 'Done' && <button className="btn-primary" onClick={() => setClosing(true)}>Mark Done…</button>}
          {a.state === 'Done' && <button onClick={() => put({ state: 'Open' }, 'Reopened.')}>Reopen</button>}
        </>
      )}
    >
      <div className="chain">
        <span className="chain-step"><strong>Remedial {a.ref}</strong> <StateTag s={a.state} overdue={a.overdue} /></span>
        <span className="chain-arrow">→</span>
        <span className="chain-step">Inspection {a.visit_id ? <a href={`#/visits/${a.visit_id}`}>{a.visit_ref}</a> : <span className="warn">none (needs review)</span>} {a.visit_status_label && <span className="muted small">{a.visit_status_label}</span>}</span>
        <span className="chain-arrow">→</span>
        <span className="chain-step">Activity {a.activity_id ? <a href={`#/activities/${a.activity_id}`}>{a.activity_ref}</a> : '—'} {a.activity_type_code && <span className="muted small">{a.activity_type_code}</span>}</span>
      </div>
      <div className="status-strip">
        <PriorityTag p={a.priority} /> <span className="muted small">Due {fmtDate(a.due_on)} · Raised {fmtDate(a.created_at)}{a.closed_at && ` · Done ${fmtDate(a.closed_at)}`}</span>
      </div>
      <ErrorBox error={err} />
      {msg && <div className="note ok-note">{msg} RAG status changes only at Recalculate.</div>}
      {locked && <div className="note">Inspection {a.visit_ref} is closed, so this remedial is read-only. Reopen the inspection deliberately to change it.</div>}
      {a.priority === 'Critical' && a.state !== 'Done' && a.activity_id && <div className="note">Open Critical remedial: {a.activity_ref} will be <strong>red</strong> after the next Recalculate.</div>}
      {a.state === 'Done' && <Card title="Closure details"><p>{a.closure_notes}</p><p className="muted small">Done on {fmtDate(a.closed_at)}</p></Card>}
      <div className="grid2">
        <Card title="Details">
          <fieldset disabled={locked} className="plain">
            <Field label="Title"><input value={f.title} onChange={u('title')} /></Field>
            <Field label="Description"><textarea rows={3} value={f.description} onChange={u('description')} /></Field>
            <div className="grid2">
              <Field label="Priority"><select aria-label="Priority" value={f.priority} onChange={u('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
              <Field label="Due date"><input type="date" value={f.due_on} onChange={u('due_on')} /></Field>
            </div>
            <Field label="Owner / contact">
              <select value={f.owner_user_id} onChange={u('owner_user_id')}>
                <option value="">— none —</option>
                {core.users.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.role_label})</option>)}
              </select>
            </Field>
            <div className="grid2">
              <Field label="Room">
                <select value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value, equipment_id: '' })}>
                  <option value="">— whole site —</option>
                  {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} {r.name}</option>)}
                </select>
              </Field>
              <Field label="Equipment">
                <select value={f.equipment_id} onChange={u('equipment_id')}>
                  <option value="">— none —</option>
                  {core.equipment.filter((e) => (f.room_id ? String(e.room_id) === f.room_id : rooms.some((r) => r.id === e.room_id))).map((e) => <option key={e.id} value={e.id}>{e.asset_code} {e.description}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Notes"><textarea rows={2} value={f.notes} onChange={u('notes')} /></Field>
            <div className="form-actions">
              <button className="btn-primary" onClick={() => put({ ...f, owner_user_id: f.owner_user_id || null, due_on: f.due_on || null, room_id: f.room_id || null, equipment_id: f.equipment_id || null }, 'Saved.')}>Save details</button>
              {a.state !== 'Done' && <button onClick={async () => { try { await api.del(`/api/actions/${id}`); navigate(a.visit_id ? `#/visits/${a.visit_id}` : '#/remedials'); } catch (e: any) { setErr(e.message); } }}>Delete</button>}
            </div>
          </fieldset>
        </Card>
        <Card title="Source">
          <dl className="dl">
            <div><dt>Inspection</dt><dd>{a.visit_id ? <a href={`#/visits/${a.visit_id}`}>{a.visit_ref} ({fmtDate(a.visit_date)})</a> : '—'}</dd></div>
            <div><dt>Checklist question</dt><dd>{a.question_code ? <>{a.question_code} · {a.question_group}<br />{a.question_text}</> : '—'}</dd></div>
            <div><dt>Compliance activity</dt><dd>{a.activity_id ? <a href={`#/activities/${a.activity_id}`}>{a.activity_ref} {a.activity_type_code} {a.activity_name}</a> : '—'}</dd></div>
            <div><dt>Location</dt><dd>{[a.area_code, a.site_code, a.room_code].filter(Boolean).join(' › ') || '—'}</dd></div>
            <div><dt>Equipment</dt><dd>{a.equipment_code ? `${a.equipment_code} ${a.equipment_description}` : '—'}</dd></div>
          </dl>
          {a.needs_review ? <p className="warn small">Upgraded from an older version without an inspection link: review it.</p> : null}
        </Card>
      </div>
      <DocumentsPanel kind="action" id={id} />
      {closing && (
        <Modal title={`Mark ${a.ref} Done`} onClose={() => setClosing(false)}>
          <ErrorBox error={err} />
          <Field label="Closure details (required)" hint="What was done, by whom, and how it was confirmed.">
            <textarea aria-label="Closure details" rows={4} value={closure.closure_notes} onChange={(e) => setClosure({ ...closure, closure_notes: e.target.value })} />
          </Field>
          <Field label="Done on" hint="Blank = today"><input type="date" value={closure.closed_on} onChange={(e) => setClosure({ ...closure, closed_on: e.target.value })} /></Field>
          <div className="form-actions">
            <button className="btn-primary" onClick={async () => { if (await put({ state: 'Done', ...closure, closed_on: closure.closed_on || null }, 'Remedial Done.')) setClosing(false); }}>Mark Done</button>
            <button onClick={() => setClosing(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
