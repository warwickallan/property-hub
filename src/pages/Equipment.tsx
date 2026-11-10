import { useEffect, useState } from 'react';
import { api, type Core, type Row } from '../api';
import { Card, DataTable, DocumentsPanel, ErrorBox, Field, Loading, LocationSelects, Modal, Page, StatusChip, useStoredState, type LocFilter } from '../components';
import { fmtDate, locationLabel, navigate, useLoad } from '../util';

export function EquipmentRegister() {
  const { data: core } = useLoad<Core>('/api/core');
  const { data: rows, error, reload } = useLoad<Row[]>('/api/equipment');
  const [f, setF] = useStoredState<LocFilter & { q: string; category: string; status: string }>('ph:equip', { area: '', site: '', room: '', q: '', category: '', status: '' });
  const [adding, setAdding] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!core || !rows) return <Loading />;
  const cats = [...new Set(rows.map((e) => e.category).filter(Boolean))].sort();
  const q = f.q.toLowerCase();
  const list = rows.filter((e) =>
    (!f.area || String(e.area_id) === f.area) && (!f.site || String(e.site_id) === f.site) && (!f.room || String(e.room_id) === f.room) &&
    (!f.category || e.category === f.category) && (!f.status || String(e.active) === f.status) &&
    (!q || `${e.asset_code} ${e.description} ${e.category} ${e.serial_no ?? ''} ${e.room_name} ${e.site_name}`.toLowerCase().includes(q)));
  return (
    <Page title="Equipment" actions={<button className="btn-primary" onClick={() => setAdding(true)}>+ New Equipment</button>}>
      <div className="filters">
        <LocationSelects core={core} value={f} onChange={(v) => setF({ ...f, ...v })} />
        <select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select aria-label="Equipment status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Active & archived</option>
          <option value="1">Active</option>
          <option value="0">Archived</option>
        </select>
        <input type="search" placeholder="Search asset, description, serial…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <Card>
        <DataTable
          rows={list}
          initialSort={{ key: 'asset_code', dir: 1 }}
          onRowClick={(e) => navigate(`#/equipment/${e.id}`)}
          cols={[
            { key: 'asset_code', label: 'Asset code', render: (e) => <strong>{e.asset_code}</strong> },
            { key: 'description', label: 'Description' },
            { key: 'category', label: 'Category' },
            { key: 'area_code', label: 'Area' },
            { key: 'site_code', label: 'Site', render: (e) => `${e.site_code} ${e.site_name}` },
            { key: 'room_code', label: 'Room', render: (e) => `${e.room_code} ${e.room_name}` },
            { key: 'serial_no', label: 'Serial' },
            { key: 'active', label: 'Status', render: (e) => (e.active ? 'Active' : 'Archived') },
            { key: 'activity_count', label: 'Activities', className: 'num' },
          ]}
        />
      </Card>
      {adding && <EquipmentModal core={core} onClose={() => setAdding(false)} onSaved={(e) => { setAdding(false); reload(); navigate(`#/equipment/${e.id}`); }} />}
    </Page>
  );
}

export function EquipmentModal({ core, onClose, onSaved, roomId }: { core: Core; onClose: () => void; onSaved: (e: Row) => void; roomId?: number }) {
  const room = roomId ? core.rooms.find((r) => r.id === roomId) : null;
  const [loc, setLoc] = useState<LocFilter>({ area: room ? String(room.area_id) : '', site: room ? String(room.site_id) : '', room: room ? String(room.id) : '' });
  const [f, setF] = useState({ description: '', category: '', serial_no: '', asset_code: '' });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    if (!loc.room) return setErr('Choose a Room — equipment always belongs to a Room.');
    try {
      onSaved(await api.post('/api/equipment', { ...f, room_id: Number(loc.room) }));
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="New equipment" onClose={onClose}>
      <ErrorBox error={err} />
      <Field label="Location (Area › Site › Room — Room required)">
        <div className="filters"><LocationSelects core={core} value={loc} onChange={setLoc} /></div>
      </Field>
      <Field label="Description"><input aria-label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Category"><input list="cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="e.g. Portable appliance" /></Field>
      <datalist id="cats">{['Portable appliance', 'Gas appliance', 'Fixed electrical', 'Water system', 'Fire safety'].map((c) => <option key={c} value={c} />)}</datalist>
      <Field label="Serial no. (optional)"><input value={f.serial_no} onChange={(e) => setF({ ...f, serial_no: e.target.value })} /></Field>
      <Field label="Asset code (optional)" hint="Blank = auto PH-E###"><input value={f.asset_code} onChange={(e) => setF({ ...f, asset_code: e.target.value })} /></Field>
      <div className="form-actions">
        <button className="btn-primary" onClick={save}>Save equipment</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

export function EquipmentDetail({ id }: { id: number }) {
  const { data: core } = useLoad<Core>('/api/core');
  const { data: e, error, reload } = useLoad<Row>(`/api/equipment/${id}`);
  const [f, setF] = useState<Row | null>(null);
  const [loc, setLoc] = useState<LocFilter>({ area: '', site: '', room: '' });
  const [err, setErr] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Row[]>([]);
  useEffect(() => {
    if (!e) return;
    setF({ description: e.description, category: e.category, serial_no: e.serial_no ?? '', notes: e.notes, asset_code: e.asset_code, active: !!e.active });
    setLoc({ area: String(e.area_id), site: String(e.site_id), room: String(e.room_id) });
  }, [e]);
  if (error) return <ErrorBox error={error} />;
  if (!e || !core || !f) return <Loading />;
  const save = async () => {
    setErr(null);
    if (!loc.room) return setErr('Choose a Room.');
    try {
      const r = await api.put(`/api/equipment/${id}`, { ...f, room_id: Number(loc.room) });
      setWarnings(r.scope_warnings ?? []);
      reload();
    } catch (x: any) {
      setErr(x.message);
    }
  };
  const outOfScope = e.activities.filter((a: Row) => !a.in_scope);
  return (
    <Page
      title={<>{e.asset_code} · {e.description}</>}
      crumbs={<><a href="#/equipment">Equipment</a> › <a href={`#/areas/${e.area_id}`}>{e.area_code}</a> › <a href={`#/sites/${e.site_id}`}>{e.site_code} {e.site_name}</a> › <a href={`#/rooms/${e.room_id}`}>{e.room_code} {e.room_name}</a></>}
    >
      <ErrorBox error={err} />
      {(warnings.length > 0 || outOfScope.length > 0) && (
        <div className="error">⚠ This equipment is now outside the scope of linked activit{(warnings.length || outOfScope.length) === 1 ? 'y' : 'ies'}: {(warnings.length ? warnings : outOfScope).map((w: Row) => w.ref).join(', ')}. Review those links.</div>
      )}
      <div className="grid2">
        <Card title="Details">
          <Field label="Room (move by changing Room)"><div className="filters"><LocationSelects core={core} value={loc} onChange={setLoc} /></div></Field>
          <Field label="Asset code"><input value={f.asset_code} onChange={(x) => setF({ ...f, asset_code: x.target.value })} /></Field>
          <Field label="Description"><input value={f.description} onChange={(x) => setF({ ...f, description: x.target.value })} /></Field>
          <Field label="Category"><input value={f.category} onChange={(x) => setF({ ...f, category: x.target.value })} /></Field>
          <Field label="Serial no."><input value={f.serial_no} onChange={(x) => setF({ ...f, serial_no: x.target.value })} /></Field>
          <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(x) => setF({ ...f, notes: x.target.value })} /></Field>
          <label className="inline"><input type="checkbox" checked={f.active} onChange={(x) => setF({ ...f, active: x.target.checked })} /> Active</label>
          <div className="form-actions"><button className="btn-primary" onClick={save}>Save</button></div>
        </Card>
        <Card title={`Linked compliance activities (${e.activities.length})`}>
          <DataTable
            rows={e.activities}
            empty="Not linked to any activity"
            onRowClick={(a) => navigate(`#/activities/${a.id}`)}
            cols={[
              { key: 'ref', label: 'Ref' },
              { key: 'type_code', label: 'Type' },
              { key: 'scope', label: 'Scope', render: (a) => `${a.site_code ?? a.area_code} · ${locationLabel(a)}` },
              { key: 'next_due_on', label: 'Next due', render: (a) => fmtDate(a.snap_due_on ?? a.next_due_on) },
              { key: 'status', label: 'Status', render: (a) => <StatusChip status={a.status} /> },
              { key: 'in_scope', label: '', render: (a) => (a.in_scope ? '' : <span className="warn">Out of scope</span>) },
            ]}
          />
        </Card>
      </div>
      <DocumentsPanel kind="equipment" id={id} />
    </Page>
  );
}
