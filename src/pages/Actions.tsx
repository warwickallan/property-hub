import { useState } from 'react';
import { api, type Row } from '../api';
import { Card, DataTable, ErrorBox, Loading, Page, useStoredState } from '../components';
import { fmtDate, useLoad } from '../util';

export function ActionsRegister() {
  const { data, error, reload } = useLoad<Row[]>('/api/actions');
  const [f, setF] = useStoredState('ph:actions', { state: 'open', priority: '', q: '' });
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const q = f.q.toLowerCase();
  const rows = data.filter((x) =>
    (f.state === 'open' ? x.state !== 'Done' : !f.state || x.state === f.state) && (!f.priority || x.priority === f.priority) &&
    (!q || `${x.title} ${x.activity_ref ?? ''} ${x.site_code ?? ''} ${x.owner_name ?? ''}`.toLowerCase().includes(q)));
  const setState = async (x: Row, state: string) => {
    setErr(null);
    try {
      await api.put(`/api/actions/${x.id}`, { state });
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Page title="Actions">
      <p className="muted small">Create actions from an Activity's Actions tab. An open Critical action makes its activity red at the next Recalculate. Full inspection-driven actions are P1.</p>
      <ErrorBox error={err} />
      <div className="filters">
        <select aria-label="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
          <option value="open">Open + in progress</option>
          <option value="">All</option>
          {['Open', 'In progress', 'Done'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select aria-label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
          <option value="">All priorities</option>
          {['Critical', 'High', 'Medium', 'Low'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <input type="search" placeholder="Search…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <Card>
        <DataTable
          rows={rows}
          cols={[
            { key: 'title', label: 'Action' },
            { key: 'priority', label: 'Priority', render: (x) => <span className={x.priority === 'Critical' ? 'warn' : ''}>{x.priority}</span>, sort: (x) => ['Critical', 'High', 'Medium', 'Low'].indexOf(x.priority) },
            { key: 'activity_ref', label: 'Source activity', render: (x) => (x.activity_id ? <a href={`#/activities/${x.activity_id}`}>{x.activity_ref}</a> : '—') },
            { key: 'site_code', label: 'Site', render: (x) => (x.site_id ? <a href={`#/sites/${x.site_id}`}>{x.site_code}</a> : '—') },
            { key: 'owner_name', label: 'Owner' },
            { key: 'due_on', label: 'Due', render: (x) => fmtDate(x.due_on) },
            { key: 'state', label: 'State', render: (x) => (
              <select aria-label={`State of ${x.title}`} value={x.state} onChange={(e) => setState(x, e.target.value)}>
                {['Open', 'In progress', 'Done'].map((s) => <option key={s}>{s}</option>)}
              </select>
            ) },
          ]}
        />
      </Card>
    </Page>
  );
}
