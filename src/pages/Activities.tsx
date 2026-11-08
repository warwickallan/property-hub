import { useMemo } from 'react';
import type { Core, Row } from '../api';
import { Card, DataTable, ErrorBox, Loading, LocationSelects, Page, StatusChip, Tabs, useStoredState, type Col, type LocFilter } from '../components';
import { fmtDate, locationLabel, navigate, STATUS_LABEL, useLoad } from '../util';

interface Filters extends LocFilter {
  type: string;
  status: string;
  owner: string;
  equipment: string;
  from: string;
  to: string;
  q: string;
  applicability: string;
  evidence: string;
  view: string;
}
const EMPTY: Filters = { area: '', site: '', room: '', type: '', status: '', owner: '', equipment: '', from: '', to: '', q: '', applicability: '', evidence: '', view: 'all' };

const dueOf = (a: Row) => a.snap_due_on ?? a.next_due_on ?? null;
const missingEvidence = (a: Row) => !!a.evidence_required && a.applicability === 'required' && !a.verified_doc_count;

function applyFilters(rows: Row[], f: Filters, core: Core) {
  const roomEquip = f.room ? new Set(core.equipment.filter((e) => String(e.room_id) === f.room).map((e) => e.id)) : null;
  const q = f.q.trim().toLowerCase();
  return rows.filter((a) => {
    if (f.area && String(a.area_id) !== f.area) return false;
    if (f.site && String(a.site_id) !== f.site) return false;
    if (f.room && String(a.room_id) !== f.room && !a.equipment_ids.some((id: number) => roomEquip!.has(id))) return false;
    if (f.type && String(a.type_id) !== f.type) return false;
    if (f.status === 'none' ? a.status : f.status && a.status !== f.status) return false;
    if (f.owner && String(a.owner_user_id ?? '') !== f.owner) return false;
    if (f.equipment && !a.equipment_ids.includes(Number(f.equipment))) return false;
    const due = dueOf(a);
    if (f.from && (!due || due < f.from)) return false;
    if (f.to && (!due || due > f.to)) return false;
    if (f.applicability && a.applicability !== f.applicability) return false;
    if (f.evidence === 'missing' && !missingEvidence(a)) return false;
    if (f.evidence === 'verified' && !a.verified_doc_count) return false;
    if (q && !`${a.ref} ${a.name} ${a.type_name} ${a.type_code} ${a.area_name} ${a.site_code} ${a.site_name} ${a.room_code ?? ''} ${a.room_name ?? ''} ${a.owner_name ?? ''}`.toLowerCase().includes(q)) return false;
    if (f.view === 'overdue' && a.status !== 'red') return false;
    if (f.view === 'due' && a.status !== 'amber') return false;
    if (f.view === 'evidence' && !missingEvidence(a)) return false;
    return true;
  });
}

const COLS: Col[] = [
  { key: 'ref', label: 'Ref', render: (a) => <strong>{a.ref}</strong> },
  { key: 'area_code', label: 'Area', render: (a) => a.area_code },
  {
    key: 'site_code', label: 'Site',
    render: (a) => a.site_id ? <a href={`#/sites/${a.site_id}`} onClick={(e) => e.stopPropagation()}>{a.site_code} {a.site_name}</a> : '—',
  },
  { key: 'scope', label: 'Scope', render: (a) => locationLabel(a), sort: (a) => `${a.location_level}${a.room_code ?? ''}` },
  { key: 'type_code', label: 'Type' },
  { key: 'name', label: 'Activity', render: (a) => a.name || '—' },
  { key: 'equipment_count', label: 'Equip.', className: 'num' },
  { key: 'last_done_on', label: 'Last done', render: (a) => fmtDate(a.last_done_on) },
  { key: 'next_due', label: 'Next due', render: (a) => fmtDate(dueOf(a)), sort: dueOf },
  { key: 'days_to_due', label: 'Days', className: 'num', render: (a) => a.days_to_due ?? '—' },
  { key: 'status', label: 'Status', render: (a) => <StatusChip status={a.status} title={a.status_reason} />, sort: (a) => ({ red: 0, amber: 1, grey: 2, green: 3, na: 4 } as Row)[a.status] ?? 5 },
  { key: 'owner_name', label: 'Responsible', render: (a) => a.owner_name ?? '—' },
  {
    key: 'evidence', label: 'Evidence', sort: (a) => a.verified_doc_count,
    render: (a) => a.verified_doc_count ? <span className="ok">✔ Verified</span> : a.doc_count ? <span className="warn">Unverified</span> : <span className="muted">None</span>,
  },
  { key: 'open_actions', label: 'Actions', className: 'num', render: (a) => a.open_actions || '—' },
];

function FilterBar({ core, f, set, extended }: { core: Core; f: Filters; set: (f: Filters) => void; extended?: boolean }) {
  const u = (k: keyof Filters) => (e: { target: { value: string } }) => set({ ...f, [k]: e.target.value });
  const equipmentChoices = core.equipment.filter((e) => {
    const r = core.rooms.find((x) => x.id === e.room_id);
    return (!f.room || String(e.room_id) === f.room) && (!f.site || String(r?.site_id) === f.site) && (!f.area || String(r?.area_id) === f.area);
  });
  return (
    <div className="filters">
      <LocationSelects core={core} value={f} onChange={(v) => set({ ...f, ...v, equipment: '' })} />
      <select aria-label="Type" value={f.type} onChange={u('type')}>
        <option value="">All types</option>
        {core.types.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
      </select>
      <select aria-label="Status" value={f.status} onChange={u('status')}>
        <option value="">All statuses</option>
        {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        <option value="none">Not yet calculated</option>
      </select>
      <select aria-label="Responsible" value={f.owner} onChange={u('owner')}>
        <option value="">Anyone responsible</option>
        {core.users.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <select aria-label="Equipment" value={f.equipment} onChange={u('equipment')}>
        <option value="">Any equipment</option>
        {equipmentChoices.map((e) => <option key={e.id} value={e.id}>{e.asset_code} {e.description}</option>)}
      </select>
      <label className="inline small">Due from <input type="date" value={f.from} onChange={u('from')} /></label>
      <label className="inline small">to <input type="date" value={f.to} onChange={u('to')} /></label>
      {extended && (
        <>
          <select aria-label="Applicability" value={f.applicability} onChange={u('applicability')}>
            <option value="">Any applicability</option>
            <option value="required">Required</option>
            <option value="not_applicable">Not applicable</option>
            <option value="unknown">Unknown</option>
          </select>
          <select aria-label="Evidence" value={f.evidence} onChange={u('evidence')}>
            <option value="">Any evidence</option>
            <option value="verified">Has verified evidence</option>
            <option value="missing">Missing verified evidence</option>
          </select>
        </>
      )}
      <input type="search" placeholder="Search ref, name, site, owner…" value={f.q} onChange={u('q')} />
      <button className="btn-ghost" onClick={() => set({ ...EMPTY, view: f.view })}>Clear</button>
    </div>
  );
}

function useActivityData() {
  const core = useLoad<Core>('/api/core');
  const acts = useLoad<Row[]>('/api/activities');
  return { core: core.data, acts: acts.data, error: core.error ?? acts.error };
}

function Grouped({ rows, by }: { rows: Row[]; by: 'site' | 'type' }) {
  const groups = new Map<string, { key: string; label: string; href?: string; rows: Row[] }>();
  for (const a of rows) {
    const k = by === 'site' ? (a.site_id ? `s${a.site_id}` : `a${a.area_id}`) : `t${a.type_id}`;
    const label = by === 'site' ? (a.site_id ? `${a.area_code} › ${a.site_code} ${a.site_name}` : `${a.area_code} ${a.area_name} (area-wide)`) : `${a.type_code} — ${a.type_name}`;
    const href = by === 'site' ? (a.site_id ? `#/sites/${a.site_id}` : `#/areas/${a.area_id}`) : undefined;
    if (!groups.has(k)) groups.set(k, { key: k, label, href, rows: [] });
    groups.get(k)!.rows.push(a);
  }
  const count = (g: Row[], s: string | null) => g.filter((a) => (s ? a.status === s : !a.status)).length;
  return (
    <DataTable
      rows={[...groups.values()].map((g) => ({ id: g.key, ...g }))}
      initialSort={{ key: 'label', dir: 1 }}
      onRowClick={(g) => g.href && navigate(g.href)}
      cols={[
        { key: 'label', label: by === 'site' ? 'Location' : 'Compliance type' },
        { key: 'n', label: 'Activities', className: 'num', render: (g) => g.rows.length, sort: (g) => g.rows.length },
        ...(['red', 'amber', 'grey', 'green', 'na'] as const).map((s) => ({
          key: s, label: STATUS_LABEL[s], className: 'num', sort: (g: Row) => count(g.rows, s),
          render: (g: Row) => { const n = count(g.rows, s); return n ? <span className={`chip chip-${s}`}>{n}</span> : '—'; },
        })),
        { key: 'none', label: 'Not calculated', className: 'num', render: (g) => count(g.rows, null) || '—', sort: (g) => count(g.rows, null) },
      ]}
    />
  );
}

export function Dashboard() {
  const { core, acts, error } = useActivityData();
  const { data: actions } = useLoad<Row[]>('/api/actions');
  const [f, setF] = useStoredState<Filters>('ph:dash', EMPTY);
  const filtered = useMemo(() => (core && acts ? applyFilters(acts, { ...f, view: 'all' }, core) : []), [core, acts, f]);
  if (error) return <ErrorBox error={error} />;
  if (!core || !acts) return <Loading />;
  const n = (s: string | null) => filtered.filter((a) => (s ? a.status === s : !a.status)).length;
  const viewRows = applyFilters(filtered, { ...EMPTY, view: f.view }, core);
  const kpis: [string, number, string, string][] = [
    ['Sites', new Set(filtered.map((a) => a.site_id).filter(Boolean)).size || core.sites.length, '', ''],
    ['Activities', filtered.length, '', 'all'],
    ['Compliant', n('green'), 'green', 'all'],
    ['Due soon', n('amber'), 'amber', 'due'],
    ['Overdue / at risk', n('red'), 'red', 'overdue'],
    ['Unknown', n('grey') + n(null), 'grey', 'all'],
    ['Open actions', (actions ?? []).filter((x) => x.state !== 'Done').length, '', ''],
  ];
  return (
    <Page title="Dashboard" actions={<a className="btn btn-primary" href="#/activities/new">+ New Activity</a>}>
      {!acts.some((a) => a.status) && <div className="note">Statuses are <strong>Not yet calculated</strong>. Click <strong>Recalculate Compliance</strong> in the header.</div>}
      <div className="kpis">
        {kpis.map(([label, value, cls, view]) => (
          <button key={label} className={`kpi kpi-${cls || 'plain'}`} onClick={() => view && setF({ ...f, view })} disabled={!view}>
            <span className="kpi-value">{value}</span>
            <span className="kpi-label">{label}</span>
          </button>
        ))}
      </div>
      <FilterBar core={core} f={f} set={setF} />
      <Tabs
        active={f.view}
        onChange={(view) => setF({ ...f, view })}
        tabs={[
          { key: 'all', label: 'All', count: filtered.length },
          { key: 'overdue', label: 'Overdue', count: n('red') },
          { key: 'due', label: 'Due Soon', count: n('amber') },
          { key: 'location', label: 'By Location' },
          { key: 'type', label: 'By Type' },
          { key: 'evidence', label: 'Missing Evidence', count: filtered.filter(missingEvidence).length },
        ]}
      />
      {f.view === 'location' ? <Grouped rows={filtered} by="site" />
        : f.view === 'type' ? <Grouped rows={filtered} by="type" />
          : <DataTable cols={COLS} rows={viewRows} onRowClick={(a) => navigate(`#/activities/${a.id}`)} initialSort={{ key: 'status', dir: 1 }} empty="No activities match these filters" />}
    </Page>
  );
}

export function ActivitiesRegister() {
  const { core, acts, error } = useActivityData();
  const [f, setF] = useStoredState<Filters>('ph:acts', EMPTY);
  const rows = useMemo(() => (core && acts ? applyFilters(acts, { ...f, view: 'all' }, core) : []), [core, acts, f]);
  if (error) return <ErrorBox error={error} />;
  if (!core || !acts) return <Loading />;
  return (
    <Page title="Compliance Activities" actions={<a className="btn btn-primary" href="#/activities/new">+ New Activity</a>}>
      <FilterBar core={core} f={f} set={setF} extended />
      <Card>
        <DataTable
          cols={[...COLS.slice(0, 9), { key: 'interval_months', label: 'Interval', render: (a) => (a.interval_months ?? a.type_interval) ? `${a.interval_months ?? a.type_interval} mo` : '—' }, ...COLS.slice(9)]}
          rows={rows}
          onRowClick={(a) => navigate(`#/activities/${a.id}`)}
          initialSort={{ key: 'ref', dir: 1 }}
        />
      </Card>
    </Page>
  );
}
