import { useEffect, useState } from 'react';
import { api, type Core, type Row } from '../api';
import { Card, DataTable, ErrorBox, Field, Loading, Modal, Page } from '../components';
import { useLoad } from '../util';

// ---------- People / Users (directory contacts; no logins) ----------
export function AdminPeople() {
  const { data, error, reload } = useLoad<Row[]>('/api/users');
  const [edit, setEdit] = useState<Row | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="People / Users" crumbs="Admin / Setup" actions={<button className="btn-primary" onClick={() => setEdit({})}>+ Add person</button>}>
      <p className="muted small">Directory and reminder recipients only. One operator uses Property Hub; nobody here gets a login.</p>
      <Card>
        <DataTable
          rows={data}
          onRowClick={setEdit}
          cols={[
            { key: 'name', label: 'Name' },
            { key: 'email', label: 'Email', render: (u) => u.email || <span className="muted">none</span> },
            { key: 'team', label: 'Team' },
            { key: 'role_label', label: 'Role' },
            { key: 'active', label: 'Status', render: (u) => (u.active ? 'Active' : 'Disabled') },
          ]}
        />
      </Card>
      {edit && <PersonModal u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Page>
  );
}

function PersonModal({ u, onClose, onSaved }: { u: Row; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: u.name ?? '', email: u.email ?? '', team: u.team ?? '', role_label: u.role_label ?? 'Contact', active: u.id ? !!u.active : true });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      u.id ? await api.put(`/api/users/${u.id}`, f) : await api.post('/api/users', f);
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={u.id ? `Edit ${u.name}` : 'Add person'} onClose={onClose}>
      <ErrorBox error={err} />
      <Field label="Name"><input aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Email"><input aria-label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Team"><input value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} /></Field>
      <Field label="Role label">
        <select aria-label="Role" value={f.role_label} onChange={(e) => setF({ ...f, role_label: e.target.value })}>
          {['Operator', 'Team Leader', 'Contact'].map((r) => <option key={r}>{r}</option>)}
        </select>
      </Field>
      <label className="inline"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      <div className="form-actions"><button className="btn-primary" onClick={save}>Save</button><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

// ---------- Core Data: Area > Site > Room cascading editor ----------
type Kind = 'area' | 'site' | 'room';
const PLURAL: Record<Kind, string> = { area: 'areas', site: 'sites', room: 'rooms' };

export function AdminCoreData() {
  const { data: core, error, reload } = useLoad<Core>('/api/core');
  const [area, setArea] = useState<number | null>(null);
  const [site, setSite] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ kind: Kind; row: Row } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    if (core && area === null && core.areas[0]) setArea(core.areas[0].id);
  }, [core, area]);
  if (error) return <ErrorBox error={error} />;
  if (!core) return <Loading />;
  const vis = (r: Row) => showArchived || r.active;
  const sites = core.sites.filter((s) => s.area_id === area && vis(s));
  const rooms = core.rooms.filter((r) => r.site_id === site && vis(r));

  const Col = ({ kind, rows, sel, onSel, count, parentOk }: { kind: Kind; rows: Row[]; sel: number | null; onSel: (id: number) => void; count: (r: Row) => string; parentOk: boolean }) => (
    <Card
      title={`${kind[0].toUpperCase()}${kind.slice(1)}s`}
      actions={<button disabled={!parentOk} onClick={() => setEdit({ kind, row: {} })}>+ Add {kind}</button>}
    >
      {!parentOk && <p className="muted">Select a {kind === 'site' ? 'area' : 'site'} first.</p>}
      <ul className="tree-list">
        {rows.map((r) => (
          <li key={r.id} className={sel === r.id ? 'sel' : ''}>
            <button className="tree-btn" onClick={() => onSel(r.id)}>
              <strong>{r.code}</strong> {r.name} {!r.active && <em className="muted">(archived)</em>}
              <span className="muted small"> · {count(r)}</span>
            </button>
            <span className="tree-actions">
              <a className="small" href={`#/${PLURAL[kind]}/${r.id}`}>Open</a>{' '}
              <button className="btn-ghost small" onClick={() => setEdit({ kind, row: r })}>Edit</button>
            </span>
          </li>
        ))}
        {parentOk && !rows.length && <li className="muted">None yet.</li>}
      </ul>
    </Card>
  );

  return (
    <Page title="Core Data — Area › Site › Room" crumbs="Admin / Setup" actions={<label className="inline small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>}>
      <p className="muted small">A Site is a property. Equipment is added to a Room (open the room, or use the Equipment register).</p>
      <div className="grid3">
        <Col kind="area" rows={core.areas.filter(vis)} sel={area} onSel={(id) => { setArea(id); setSite(null); }} count={(r) => `${r.site_count} sites`} parentOk />
        <Col kind="site" rows={sites} sel={site} onSel={setSite} count={(r) => `${r.room_count} rooms`} parentOk={area !== null} />
        <Col kind="room" rows={rooms} sel={null} onSel={(id) => (window.location.hash = `#/rooms/${id}`)} count={(r) => `${r.equipment_count} equipment`} parentOk={site !== null} />
      </div>
      {edit && (
        <CoreModal
          kind={edit.kind}
          row={edit.row}
          core={core}
          parentId={edit.kind === 'site' ? area : edit.kind === 'room' ? site : null}
          onClose={() => setEdit(null)}
          onSaved={(saved) => {
            setEdit(null);
            reload();
            if (edit.kind === 'area' && saved?.id) { setArea(saved.id); setSite(null); }
            if (edit.kind === 'site' && saved?.id) setSite(saved.id);
          }}
        />
      )}
    </Page>
  );
}

function CoreModal({ kind, row, core, parentId, onClose, onSaved }: { kind: Kind; row: Row; core: Core; parentId: number | null; onClose: () => void; onSaved: (r?: Row) => void }) {
  const parentKey = kind === 'site' ? 'area_id' : kind === 'room' ? 'site_id' : null;
  const [f, setF] = useState<Row>({ code: row.code ?? '', name: row.name ?? '', notes: row.notes ?? '', active: row.id ? !!row.active : true, parent: String(row[parentKey ?? ''] ?? parentId ?? '') });
  const [err, setErr] = useState<string | null>(null);
  const body = () => ({ name: f.name, notes: f.notes, active: f.active, ...(f.code || row.id ? { code: f.code } : {}), ...(parentKey ? { [parentKey]: Number(f.parent) } : {}) });
  const run = async (fn: () => Promise<Row | undefined>) => {
    setErr(null);
    try {
      onSaved(await fn());
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const parents = kind === 'site' ? core.areas : kind === 'room' ? core.sites : [];
  return (
    <Modal title={`${row.id ? 'Edit' : 'Add'} ${kind}`} onClose={onClose}>
      <ErrorBox error={err} />
      {parentKey && (
        <Field label={kind === 'site' ? 'Area (required)' : 'Site (required)'}>
          <select aria-label="Parent" value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })}>
            <option value="">Choose…</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Name"><input aria-label={`${kind} name`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Code" hint={row.id ? undefined : `Blank = auto (PH-${kind[0].toUpperCase()}###)`}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
      <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      {row.id && <label className="inline"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (untick to archive)</label>}
      <div className="form-actions">
        <button className="btn-primary" onClick={() => run(() => (row.id ? api.put(`/api/${PLURAL[kind]}/${row.id}`, body()) : api.post(`/api/${PLURAL[kind]}`, body())))}>Save</button>
        {row.id && <button onClick={() => run(async () => { await api.del(`/api/${PLURAL[kind]}/${row.id}`); return undefined; })}>Delete</button>}
        <button onClick={onClose}>Cancel</button>
      </div>
      {row.id && <p className="muted small">Delete is blocked while child records exist — archive instead.</p>}
    </Modal>
  );
}

// ---------- Compliance Types ----------
export function AdminTypes() {
  const { data, error, reload } = useLoad<Row[]>('/api/types');
  const [edit, setEdit] = useState<Row | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="Compliance Types" crumbs="Admin / Setup" actions={<button className="btn-primary" onClick={() => setEdit({})}>+ Add Type</button>}>
      <p className="muted small">Intervals are configurable working defaults, not statements of law. Confirm with the Compliance Officer.</p>
      <Card>
        <DataTable
          rows={data}
          onRowClick={setEdit}
          cols={[
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Name' },
            { key: 'suggested_interval_months', label: 'Default interval', render: (t) => (t.suggested_interval_months ? `${t.suggested_interval_months} months` : '—') },
            { key: 'warning_days', label: 'Warning days', className: 'num' },
            { key: 'evidence_required', label: 'Evidence required', render: (t) => (t.evidence_required ? 'Yes' : 'No') },
            { key: 'activity_count', label: 'Activities', className: 'num' },
            { key: 'active', label: 'Status', render: (t) => (t.active ? 'Active' : 'Archived') },
          ]}
        />
      </Card>
      {edit && <TypeModal t={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Page>
  );
}

function TypeModal({ t, onClose, onSaved }: { t: Row; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Row>({
    code: t.code ?? '', name: t.name ?? '', suggested_interval_months: t.suggested_interval_months ?? '', warning_days: t.warning_days ?? 30,
    evidence_required: t.id ? !!t.evidence_required : true, active: t.id ? !!t.active : true, notes: t.notes ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      const b = { ...f, suggested_interval_months: f.suggested_interval_months === '' ? null : Number(f.suggested_interval_months) };
      t.id ? await api.put(`/api/types/${t.id}`, b) : await api.post('/api/types', b);
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={t.id ? `Edit ${t.code}` : 'Add compliance type'} onClose={onClose}>
      <ErrorBox error={err} />
      <Field label="Code"><input aria-label="Type code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="e.g. EML" /></Field>
      <Field label="Name"><input aria-label="Type name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Emergency Lighting" /></Field>
      <div className="grid2">
        <Field label="Default interval (months)"><input type="number" min={1} value={f.suggested_interval_months} onChange={(e) => setF({ ...f, suggested_interval_months: e.target.value })} /></Field>
        <Field label="Warning days"><input type="number" min={0} value={f.warning_days} onChange={(e) => setF({ ...f, warning_days: e.target.value })} /></Field>
      </div>
      <label className="inline"><input type="checkbox" checked={f.evidence_required} onChange={(e) => setF({ ...f, evidence_required: e.target.checked })} /> Verified evidence required</label>
      <label className="inline"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="form-actions"><button className="btn-primary" onClick={save}>Save</button><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

// ---------- Settings ----------
export function AdminSettings() {
  const { data, error, setData } = useLoad<Row>('/api/settings');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const save = async () => {
    setErr(null);
    try {
      setData(await api.put('/api/settings', data));
      setMsg('Saved. Takes effect at the next Recalculate.');
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Page title="Settings" crumbs="Admin / Setup">
      <ErrorBox error={err} />
      {msg && <div className="note">{msg}</div>}
      <Card title="Calculation & reminders">
        <Field label="Operator name"><input value={data.operator_name} onChange={(e) => setData({ ...data, operator_name: e.target.value })} /></Field>
        <Field label="Default warning days" hint="Used for new compliance types. Each type has its own warning days."><input type="number" value={data.warning_days} onChange={(e) => setData({ ...data, warning_days: e.target.value })} /></Field>
        <Field label="Reminder thresholds (days before due)" hint="Comma-separated, e.g. 30,14,7. Overdue items always get an 'overdue' reminder."><input value={data.reminder_thresholds} onChange={(e) => setData({ ...data, reminder_thresholds: e.target.value })} /></Field>
        <div className="form-actions"><button className="btn-primary" onClick={save}>Save settings</button></div>
      </Card>
      <Card title="Email mode">
        <p><strong>Demo only.</strong> "Send" writes .eml files to <code>data/outbox</code>. There is no SMTP configuration, scheduler or background job in this build.</p>
      </Card>
      <Card title="Backup guidance">
        <p>All data lives in <code>data/propertyhub.db</code> (SQLite) and uploaded files in <code>data/uploads</code>. Stop the app and copy the whole <code>data</code> folder to back up. Neither is committed to Git.</p>
      </Card>
    </Page>
  );
}

export function ServiceCharges() {
  return (
    <Page title="Service Charges">
      <div className="note"><strong>Phase 2 — discovery placeholder.</strong> Requirements for service charge management are still being gathered. Nothing to configure yet.</div>
    </Page>
  );
}
