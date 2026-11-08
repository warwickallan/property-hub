import { useEffect, useMemo, useState } from 'react';
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

export const ACTION_COLS: Col[] = [
  { key: 'ref', label: 'Ref', render: (x) => <strong>{x.ref}</strong> },
  { key: 'title', label: 'Action' },
  { key: 'priority', label: 'Priority', render: (x) => <PriorityTag p={x.priority} />, sort: (x) => PRIORITIES.indexOf(x.priority) },
  { key: 'state', label: 'Status', render: (x) => <StateTag s={x.state} overdue={x.overdue} />, sort: (x) => STATES.indexOf(x.state) },
  { key: 'due_on', label: 'Due', render: (x) => fmtDate(x.due_on) },
  { key: 'owner_name', label: 'Owner', render: (x) => x.owner_name ?? '—' },
  { key: 'loc', label: 'Location', render: (x) => [x.area_code, x.site_code, x.room_code].filter(Boolean).join(' › ') || '—', sort: (x) => `${x.site_code ?? ''}${x.room_code ?? ''}` },
  { key: 'activity_ref', label: 'Activity', render: (x) => x.activity_ref ?? '—' },
  { key: 'inspection_ref', label: 'Source', render: (x) => (x.inspection_ref ? `${x.inspection_ref} ${x.question_code ?? ''}` : '—') },
];

// ---------- create / edit form (modal) ----------
export interface ActionContext {
  site_id?: number | null;
  room_id?: number | null;
  activity_id?: number | null;
  inspection_run_id?: number;
  question_code?: string;
  title?: string;
  description?: string;
  owner_user_id?: number | null;
}

export function ActionModal({ context = {}, onClose, onSaved }: { context?: ActionContext; onClose: () => void; onSaved: (a: Row) => void }) {
  const { data: core } = useLoad<Core>('/api/core');
  const { data: acts } = useLoad<Row[]>('/api/activities');
  const fixedSite = !!context.inspection_run_id;
  const [f, setF] = useState<Row>({
    title: context.title ?? '', description: context.description ?? '', priority: 'Medium', owner_user_id: String(context.owner_user_id ?? ''),
    due_on: '', site_id: String(context.site_id ?? ''), room_id: String(context.room_id ?? ''), activity_id: String(context.activity_id ?? ''), notes: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const site = core?.sites.find((s) => String(s.id) === f.site_id);
  const relevant = useMemo(() => (acts ?? []).filter((a) => !site || a.site_id === site.id || (a.location_level === 'area' && a.area_id === site.area_id)), [acts, site]);
  if (!core) return <Modal title="New remedial action" onClose={onClose}><Loading /></Modal>;
  const u = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setErr(null);
    setSaving(true);
    try {
      const body: Row = {
        title: f.title, description: f.description, priority: f.priority, owner_user_id: f.owner_user_id || null, due_on: f.due_on || null, notes: f.notes,
        activity_id: f.activity_id || null, room_id: f.room_id || null, site_id: f.site_id || null,
      };
      if (context.inspection_run_id) Object.assign(body, { inspection_run_id: context.inspection_run_id, question_code: context.question_code });
      onSaved(await api.post('/api/actions', body));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={context.question_code ? `Remedial action for ${context.question_code}` : 'New remedial action'} onClose={onClose}>
      <ErrorBox error={err} />
      <Field label="Title"><input aria-label="Action title" value={f.title} onChange={u('title')} /></Field>
      <Field label="Description"><textarea aria-label="Action description" rows={3} value={f.description} onChange={u('description')} /></Field>
      <div className="grid2">
        <Field label="Priority">
          <select aria-label="Action priority" value={f.priority} onChange={u('priority')}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Due date"><input aria-label="Action due" type="date" value={f.due_on} onChange={u('due_on')} /></Field>
      </div>
      {f.priority === 'Critical' && <div className="note">An open <strong>Critical</strong> action turns its linked Activity <strong>red at the next Recalculate</strong> (not immediately).</div>}
      <Field label="Owner / contact">
        <select aria-label="Action owner" value={f.owner_user_id} onChange={u('owner_user_id')}>
          <option value="">— none —</option>
          {core.users.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.role_label})</option>)}
        </select>
      </Field>
      <div className="grid2">
        <Field label="Site">
          <select aria-label="Action site" value={f.site_id} disabled={fixedSite} onChange={(e) => setF({ ...f, site_id: e.target.value, room_id: '', activity_id: '' })}>
            <option value="">{f.activity_id ? '(from activity)' : 'Choose…'}</option>
            {core.sites.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
          </select>
        </Field>
        <Field label="Room (optional)">
          <select aria-label="Action room" value={f.room_id} onChange={u('room_id')}>
            <option value="">— whole site —</option>
            {core.rooms.filter((r) => String(r.site_id) === f.site_id).map((r) => <option key={r.id} value={r.id}>{r.code} {r.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Linked compliance activity (optional)" hint="Only activities at this Site, its rooms, or its Area are offered.">
        <select aria-label="Action activity" value={f.activity_id} onChange={u('activity_id')}>
          <option value="">— not linked —</option>
          {relevant.map((a) => <option key={a.id} value={a.id}>{a.ref} {a.type_code} — {a.name || a.type_name} ({a.room_code ?? a.site_code ?? a.area_code})</option>)}
        </select>
      </Field>
      <Field label="Notes"><textarea rows={2} value={f.notes} onChange={u('notes')} /></Field>
      <div className="form-actions">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Create action'}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---------- register ----------
interface Filters extends LocFilter { state: string; priority: string; owner: string; overdue: boolean; dueBy: string; q: string }
const EMPTY: Filters = { area: '', site: '', room: '', state: 'active', priority: '', owner: '', overdue: false, dueBy: '', q: '' };

export function ActionsRegister() {
  const { data: core } = useLoad<Core>('/api/core');
  const { data, error, reload } = useLoad<Row[]>('/api/actions');
  const [f, setF] = useStoredState<Filters>('ph:actions2', EMPTY);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data || !core) return <Loading />;
  const q = f.q.toLowerCase();
  const rows = data.filter((x) =>
    (!f.area || String(x.area_id) === f.area) && (!f.site || String(x.site_id) === f.site) && (!f.room || String(x.room_id) === f.room) &&
    (f.state === 'active' ? x.state !== 'Done' : !f.state || x.state === f.state) && (!f.priority || x.priority === f.priority) &&
    (!f.owner || String(x.owner_user_id ?? '') === f.owner) && (!f.overdue || x.overdue) && (!f.dueBy || (x.due_on && x.due_on <= f.dueBy)) &&
    (!q || `${x.ref} ${x.title} ${x.description} ${x.activity_ref ?? ''} ${x.site_code ?? ''} ${x.site_name ?? ''} ${x.owner_name ?? ''} ${x.inspection_ref ?? ''}`.toLowerCase().includes(q)));
  const exportCsv = async () => {
    setErr(null);
    try {
      await downloadCsv('/api/export/actions', { ids: rows.map((r) => r.id) }, 'actions.csv');
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const count = (pred: (x: Row) => boolean) => data.filter(pred).length;
  return (
    <Page
      title="Actions"
      actions={<><button onClick={exportCsv}>Export CSV ({rows.length})</button><button className="btn-primary" onClick={() => setAdding(true)}>+ New action</button></>}
    >
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
        <input type="search" placeholder="Search ref, title, site, owner…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <button className="btn-ghost" onClick={() => setF(EMPTY)}>Clear</button>
      </div>
      <Card>
        <DataTable cols={ACTION_COLS} rows={rows} onRowClick={(x) => navigate(`#/actions/${x.id}`)} empty="No actions match these filters" />
      </Card>
      {adding && <ActionModal onClose={() => setAdding(false)} onSaved={(a) => { setAdding(false); reload(); navigate(`#/actions/${a.id}`); }} />}
    </Page>
  );
}

// ---------- detail ----------
export function ActionDetail({ id }: { id: number }) {
  const { data: a, error, reload } = useLoad<Row>(`/api/actions/${id}`);
  const { data: core } = useLoad<Core>('/api/core');
  const { data: acts } = useLoad<Row[]>('/api/activities');
  const [f, setF] = useState<Row | null>(null);
  const [closing, setClosing] = useState(false);
  const [closure, setClosure] = useState({ closure_notes: '', closed_on: '' });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (a) setF({ title: a.title, description: a.description, priority: a.priority, owner_user_id: String(a.owner_user_id ?? ''), due_on: a.due_on ?? '', notes: a.notes, room_id: String(a.room_id ?? ''), activity_id: String(a.activity_id ?? '') });
  }, [a]);
  if (error) return <ErrorBox error={error} />;
  if (!a || !f || !core) return <Loading />;
  const site = core.sites.find((s) => s.id === a.site_id);
  const relevant = (acts ?? []).filter((x) => !site || x.site_id === site.id || (x.location_level === 'area' && x.area_id === site.area_id));
  const put = async (body: Row, note: string) => {
    setErr(null);
    setMsg(null);
    try {
      await api.put(`/api/actions/${id}`, body);
      setMsg(note);
      reload();
      return true;
    } catch (e: any) {
      setErr(e.message);
      return false;
    }
  };
  const affects = a.priority === 'Critical' && a.activity_id;
  const u = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Page
      crumbs={<><a href="#/actions">Actions</a>{a.site_id && <> › <a href={`#/sites/${a.site_id}`}>{a.site_code} {a.site_name}</a></>}{a.room_id && <> › <a href={`#/rooms/${a.room_id}`}>{a.room_code} {a.room_name}</a></>}</>}
      title={<>{a.ref} · {a.title}</>}
      actions={
        <>
          {a.state === 'Open' && <button onClick={() => put({ state: 'In progress' }, 'Marked In progress.')}>Start (In progress)</button>}
          {a.state !== 'Done' && <button className="btn-primary" onClick={() => setClosing(true)}>Close action…</button>}
          {a.state === 'Done' && <button onClick={() => put({ state: 'Open' }, 'Reopened.')}>Reopen</button>}
        </>
      }
    >
      <div className="status-strip">
        <PriorityTag p={a.priority} /> <StateTag s={a.state} overdue={a.overdue} />
        <span className="muted small">Due {fmtDate(a.due_on)} · Created {fmtDate(a.created_at)}{a.closed_at && ` · Closed ${fmtDate(a.closed_at)}`}</span>
      </div>
      <ErrorBox error={err} />
      {msg && <div className="note">{msg}{affects ? ' Compliance status changes at the next Recalculate.' : ''}</div>}
      {affects && a.state !== 'Done' && <div className="note">Open Critical action linked to <a href={`#/activities/${a.activity_id}`}>{a.activity_ref}</a>: that activity will be <strong>red</strong> after the next Recalculate.</div>}
      {a.state === 'Done' && (
        <Card title="Closure details">
          <p>{a.closure_notes}</p>
          <p className="muted small">Closed on {fmtDate(a.closed_at)}</p>
        </Card>
      )}
      <div className="grid2">
        <Card title="Details">
          <Field label="Title"><input value={f.title} onChange={u('title')} /></Field>
          <Field label="Description"><textarea rows={3} value={f.description} onChange={u('description')} /></Field>
          <div className="grid2">
            <Field label="Priority">
              <select aria-label="Priority" value={f.priority} onChange={u('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
            </Field>
            <Field label="Due date"><input type="date" value={f.due_on} onChange={u('due_on')} /></Field>
          </div>
          <Field label="Owner / contact">
            <select value={f.owner_user_id} onChange={u('owner_user_id')}>
              <option value="">— none —</option>
              {core.users.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.role_label})</option>)}
            </select>
          </Field>
          <Field label="Room">
            <select value={f.room_id} onChange={u('room_id')}>
              <option value="">— whole site —</option>
              {core.rooms.filter((r) => r.site_id === a.site_id).map((r) => <option key={r.id} value={r.id}>{r.code} {r.name}</option>)}
            </select>
          </Field>
          <Field label="Linked compliance activity">
            <select aria-label="Linked activity" value={f.activity_id} onChange={u('activity_id')}>
              <option value="">— not linked —</option>
              {relevant.map((x) => <option key={x.id} value={x.id}>{x.ref} {x.type_code} — {x.name || x.type_name}</option>)}
            </select>
          </Field>
          <Field label="Notes"><textarea rows={2} value={f.notes} onChange={u('notes')} /></Field>
          <div className="form-actions">
            <button className="btn-primary" onClick={() => put({ ...f, owner_user_id: f.owner_user_id || null, due_on: f.due_on || null, room_id: f.room_id || null, activity_id: f.activity_id || null }, 'Saved.')}>Save details</button>
            {a.state !== 'Done' && <button onClick={async () => { try { await api.del(`/api/actions/${id}`); navigate('#/actions'); } catch (e: any) { setErr(e.message); } }}>Delete</button>}
          </div>
        </Card>
        <Card title="Source & links">
          <dl className="dl">
            <div><dt>Source inspection</dt><dd>{a.inspection_run_id ? <a href={`#/inspections/${a.inspection_run_id}`}>{a.inspection_ref} ({fmtDate(a.inspection_date)})</a> : '—'}</dd></div>
            <div><dt>Question</dt><dd>{a.question_code ? <>{a.question_code} · {a.question_group}<br />{a.question_text}</> : '—'}</dd></div>
            <div><dt>Activity</dt><dd>{a.activity_id ? <a href={`#/activities/${a.activity_id}`}>{a.activity_ref} {a.activity_type_code} {a.activity_name}</a> : '—'}</dd></div>
            <div><dt>Location</dt><dd>{[a.area_code, a.site_code, a.room_code].filter(Boolean).join(' › ') || '—'}</dd></div>
            <div><dt>Owner</dt><dd>{a.owner_name ? `${a.owner_name}${a.owner_email ? ` <${a.owner_email}>` : ''}` : '—'}</dd></div>
          </dl>
        </Card>
      </div>
      <DocumentsPanel kind="action" id={id} />
      {closing && (
        <Modal title={`Close ${a.ref}`} onClose={() => setClosing(false)}>
          <ErrorBox error={err} />
          <Field label="Closure details (required)" hint="What was done, by whom, and how it was confirmed.">
            <textarea aria-label="Closure details" rows={4} value={closure.closure_notes} onChange={(e) => setClosure({ ...closure, closure_notes: e.target.value })} />
          </Field>
          <Field label="Closed on" hint="Blank = today"><input type="date" value={closure.closed_on} onChange={(e) => setClosure({ ...closure, closed_on: e.target.value })} /></Field>
          <div className="form-actions">
            <button className="btn-primary" onClick={async () => { if (await put({ state: 'Done', ...closure, closed_on: closure.closed_on || null }, 'Action closed.')) setClosing(false); }}>Mark Done</button>
            <button onClick={() => setClosing(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
