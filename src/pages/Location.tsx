import { useState } from 'react';
import type { Core, Row } from '../api';
import { Card, DataTable, DocumentsPanel, ErrorBox, Loading, Page, StatusChip, type Col } from '../components';
import { fmtDate, LEVEL_LABEL, locationLabel, navigate, STATUS_LABEL, useLoad } from '../util';
import { EquipmentModal } from './Equipment';

const ACT_COLS: Col[] = [
  { key: 'ref', label: 'Ref', render: (a) => <strong>{a.ref}</strong> },
  { key: 'type_code', label: 'Type' },
  { key: 'name', label: 'Activity' },
  { key: 'scope', label: 'Scope', render: (a) => (a.location_level === 'area' ? `Area ${a.area_code}` : a.location_level === 'site' ? `Site ${a.site_code}` : locationLabel(a)) },
  { key: 'equipment_count', label: 'Equip.', className: 'num' },
  { key: 'due', label: 'Next due', render: (a) => fmtDate(a.snap_due_on ?? a.next_due_on), sort: (a) => a.snap_due_on ?? a.next_due_on },
  { key: 'status', label: 'Status', render: (a) => <StatusChip status={a.status} title={a.status_reason} /> },
  { key: 'evidence', label: 'Evidence', render: (a) => (a.verified_doc_count ? <span className="ok">✔</span> : a.evidence_required ? <span className="warn">Missing</span> : '—') },
  { key: 'owner_name', label: 'Responsible' },
];

export function LocationDetail({ kind, id }: { kind: 'area' | 'site' | 'room'; id: number }) {
  const { data: d, error, reload } = useLoad<Row>(`/api/locations/${kind}/${id}`);
  const { data: core } = useLoad<Core>('/api/core');
  const [addEquip, setAddEquip] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Loading />;
  const e = d.entity;
  const all = [...d.activities, ...d.inherited];
  const count = (s: string) => all.filter((a: Row) => a.status === s).length;
  const missing = all.filter((a: Row) => a.evidence_required && a.applicability === 'required' && !a.verified_doc_count).length;
  return (
    <Page
      crumbs={d.breadcrumb.map((b: Row, i: number) => (
        <span key={b.kind}>{i > 0 && ' › '}<a href={`#/${b.kind}s/${b.id}`}>{b.code} {b.name}</a></span>
      ))}
      title={<>{LEVEL_LABEL[kind]} {e.code} · {e.name} {!e.active && <span className="chip chip-none">Archived</span>}</>}
      actions={<><a className="btn btn-primary" href="#/activities/new">+ New Activity</a> <a className="btn" href="#/admin/core">Edit in Core Data</a></>}
    >
      {kind === 'site' && <p className="muted">Property front sheet — everything due at this site, including area-wide obligations.</p>}
      <div className="kpis">
        <div className="kpi kpi-plain"><span className="kpi-value">{all.length}</span><span className="kpi-label">Activities</span></div>
        {(['red', 'amber', 'grey', 'green'] as const).map((s) => (
          <div key={s} className={`kpi kpi-${s}`}><span className="kpi-value">{count(s)}</span><span className="kpi-label">{STATUS_LABEL[s]}</span></div>
        ))}
        <div className="kpi kpi-grey"><span className="kpi-value">{missing}</span><span className="kpi-label">Missing evidence</span></div>
        <div className="kpi kpi-plain"><span className="kpi-value">{d.equipment.length}</span><span className="kpi-label">Equipment</span></div>
      </div>
      <Card title={`Activities at this ${kind} (${d.activities.length})`}>
        <DataTable cols={ACT_COLS} rows={d.activities} onRowClick={(a) => navigate(`#/activities/${a.id}`)} empty="None" />
      </Card>
      {kind !== 'area' && d.inherited.length > 0 && (
        <Card title={`Inherited from parent location (${d.inherited.length})`}>
          <DataTable cols={ACT_COLS} rows={d.inherited} onRowClick={(a) => navigate(`#/activities/${a.id}`)} />
        </Card>
      )}
      {kind !== 'room' && (
        <Card title={kind === 'area' ? `Sites (${d.children.length})` : `Rooms (${d.children.length})`} actions={<a href="#/admin/core">Add / edit in Core Data</a>}>
          <DataTable
            rows={d.children}
            empty={kind === 'site' ? 'No rooms yet — site-level activities still work.' : 'No sites'}
            onRowClick={(c) => navigate(`#/${kind === 'area' ? 'sites' : 'rooms'}/${c.id}`)}
            cols={[
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Name' },
              kind === 'area' ? { key: 'room_count', label: 'Rooms', className: 'num' } : { key: 'equipment_count', label: 'Equipment', className: 'num' },
              { key: 'active', label: 'Status', render: (c) => (c.active ? 'Active' : 'Archived') },
            ]}
          />
        </Card>
      )}
      <Card title={`Equipment ${kind === 'room' ? 'in this room' : 'in child rooms'} (${d.equipment.length})`} actions={kind === 'room' && <button onClick={() => setAddEquip(true)}>+ Add equipment to this room</button>}>
        <DataTable
          rows={d.equipment}
          empty="No equipment"
          onRowClick={(x) => navigate(`#/equipment/${x.id}`)}
          cols={[
            { key: 'asset_code', label: 'Asset' },
            { key: 'description', label: 'Description' },
            { key: 'category', label: 'Category' },
            { key: 'room', label: 'Room', render: (x) => `${x.room_code} ${x.room_name}` },
            { key: 'activity_count', label: 'Activities', className: 'num' },
          ]}
        />
      </Card>
      <DocumentsPanel kind={kind} id={id} title={`Documents linked directly to this ${kind}`} />
      <Card title={`Related documents (via ${kind === 'area' ? 'sites' : kind === 'site' ? 'rooms' : 'this room'}, activities and equipment)`}>
        <DataTable
          rows={d.relatedDocuments.map((x: Row, i: number) => ({ ...x, id: `${x.id}-${i}` }))}
          empty="None"
          cols={[
            { key: 'display_name', label: 'Document', render: (x) => <a href={`/api/documents/${x.id.split('-')[0]}/file`} target="_blank" rel="noreferrer">{x.display_name}</a> },
            { key: 'via', label: 'Linked via', render: (x) => <a href={x.via.href}>{x.via.label}</a>, sort: (x) => x.via.label },
            { key: 'valid_until', label: 'Valid until', render: (x) => fmtDate(x.valid_until) },
            { key: 'verified_by_operator', label: 'Verified', render: (x) => (x.verified_by_operator ? <span className="ok">✔</span> : <span className="warn">No</span>) },
          ]}
        />
      </Card>
      {addEquip && core && <EquipmentModal core={core} roomId={id} onClose={() => setAddEquip(false)} onSaved={() => { setAddEquip(false); reload(); }} />}
    </Page>
  );
}
