import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Core, type Row } from './api';
import { fmtDate, STATUS_LABEL, useLoad } from './util';

// ---------- small bits ----------
export function StatusChip({ status, title }: { status: string | null | undefined; title?: string }) {
  if (!status) return <span className="chip chip-none" title="Run Recalculate to calculate status">Not yet calculated</span>;
  return (
    <span className={`chip chip-${status}`} title={title}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="error" role="alert">{error}</div>;
}

export function Loading() {
  return <p className="muted">Loading…</p>;
}

export function Page({ title, actions, children, crumbs }: { title: ReactNode; actions?: ReactNode; children: ReactNode; crumbs?: ReactNode }) {
  return (
    <section className="page">
      {crumbs && <div className="crumbs">{crumbs}</div>}
      <div className="page-head">
        <h1>{title}</h1>
        <div className="page-actions">{actions}</div>
      </div>
      {children}
    </section>
  );
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div className="card-head">
          <h2>{title}</h2>
          <div>{actions}</div>
        </div>
      )}
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { key: string; label: string; count?: number }[]; active: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} className={active === t.key ? 'tab active' : 'tab'} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- data table ----------
export interface Col<T = Row> {
  key: string;
  label: string;
  render?: (r: T) => ReactNode;
  sort?: (r: T) => string | number | null;
  className?: string;
}

export function DataTable<T extends Row>({ cols, rows, onRowClick, empty = 'No records', initialSort }: {
  cols: Col<T>[];
  rows: T[];
  onRowClick?: (r: T) => void;
  empty?: string;
  initialSort?: { key: string; dir: 1 | -1 };
}) {
  const [sort, setSort] = useState(initialSort ?? { key: '', dir: 1 as 1 | -1 });
  const sorted = useMemo(() => {
    const c = cols.find((x) => x.key === sort.key);
    if (!c) return rows;
    const val = c.sort ?? ((r: T) => r[c.key]);
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va === vb) return 0;
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      return (va < vb ? -1 : 1) * sort.dir;
    });
  }, [rows, cols, sort]);
  return (
    <div className="table-wrap">
      <div className="table-count">{rows.length} record{rows.length === 1 ? '' : 's'}</div>
      <table className="table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={c.className}>
                <button className="th-btn" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? ((-s.dir) as 1 | -1) : 1 }))}>
                  {c.label}
                  {sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="muted center">{empty}</td>
            </tr>
          )}
          {sorted.map((r, i) => (
            <tr key={r.id ?? i} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {cols.map((c) => (
                <td key={c.key} className={c.className}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- cascading location filter ----------
export interface LocFilter {
  area: string;
  site: string;
  room: string;
}

export function LocationSelects({ core, value, onChange }: { core: Core; value: LocFilter; onChange: (v: LocFilter) => void }) {
  const sites = core.sites.filter((s) => !value.area || String(s.area_id) === value.area);
  const rooms = core.rooms.filter((r) => (!value.site || String(r.site_id) === value.site) && (!value.area || String(r.area_id) === value.area));
  return (
    <>
      <select aria-label="Area" value={value.area} onChange={(e) => onChange({ area: e.target.value, site: '', room: '' })}>
        <option value="">All areas</option>
        {core.areas.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
      </select>
      <select aria-label="Site" value={value.site} onChange={(e) => {
        const s = core.sites.find((x) => String(x.id) === e.target.value);
        onChange({ area: s ? String(s.area_id) : value.area, site: e.target.value, room: '' });
      }}>
        <option value="">All sites</option>
        {sites.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
      </select>
      <select aria-label="Room" value={value.room} onChange={(e) => {
        const r = core.rooms.find((x) => String(x.id) === e.target.value);
        onChange({ area: r ? String(r.area_id) : value.area, site: r ? String(r.site_id) : value.site, room: e.target.value });
      }}>
        <option value="">All rooms</option>
        {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} {r.name} ({r.site_code})</option>)}
      </select>
    </>
  );
}

/** Filter state that survives back-navigation within the browser session. */
export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  return [v, (nv: T) => {
    setV(nv);
    try {
      sessionStorage.setItem(key, JSON.stringify(nv));
    } catch {
      /* ignore */
    }
  }];
}

// ---------- documents panel (used on every detail screen) ----------
export function DocumentsPanel({ kind, id, title = 'Documents' }: { kind: string; id: number; title?: string }) {
  const { data: docs, reload, error } = useLoad<Row[]>(`/api/documents?entity_kind=${kind}&entity_id=${id}`);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setErr(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('entity_kind', kind);
    fd.append('entity_id', String(id));
    try {
      const d = await api.post('/api/documents', fd);
      setMsg(d.reused ? `Same file already in library as "${d.display_name}" — linked here instead of uploading a copy.` : `Uploaded "${d.display_name}". Not verified until you tick Reviewed/Verified.`);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
    if (fileRef.current) fileRef.current.value = '';
  };
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Card
      title={`${title}${docs ? ` (${docs.length})` : ''}`}
      actions={
        <>
          <input ref={fileRef} type="file" hidden data-testid={`upload-${kind}`} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <button onClick={() => fileRef.current?.click()}>Add document here</button>{' '}
          <button onClick={() => setPicking(true)}>Link existing document</button>{' '}
          <a href="#/documents" className="small">Open library</a>
        </>
      }
    >
      <ErrorBox error={err ?? error} />
      {msg && <div className="note">{msg}</div>}
      {docs && docs.length === 0 && <p className="muted">No documents linked directly to this record.</p>}
      {docs && docs.length > 0 && (
        <table className="table compact">
          <thead>
            <tr><th>Document</th><th>Valid until</th><th>Reviewed / Verified</th><th>Linked to</th><th></th></tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.link_id}>
                <td>
                  <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.display_name}</a>
                  <div className="muted small">DOC-{d.id} · {d.link_role}</div>
                </td>
                <td>{fmtDate(d.valid_until)}</td>
                <td>
                  <label className="inline">
                    <input type="checkbox" checked={!!d.verified_by_operator}
                      onChange={(e) => act(() => api.put(`/api/documents/${d.id}`, { verified_by_operator: e.target.checked }))} />
                    {d.verified_by_operator ? 'Verified' : 'Not verified'}
                  </label>
                </td>
                <td className="small">{d.links.length} record{d.links.length === 1 ? '' : 's'}</td>
                <td><button className="btn-ghost small" onClick={() => act(() => api.del(`/api/document-links/${d.link_id}`))}>Unlink</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {picking && (
        <LinkExistingModal
          exclude={new Set((docs ?? []).map((d) => d.id))}
          onClose={() => setPicking(false)}
          onPick={(docId) => act(async () => {
            await api.post(`/api/documents/${docId}/links`, { entity_kind: kind, entity_id: id });
            setPicking(false);
            setMsg('Existing document linked — no new upload.');
          })}
        />
      )}
    </Card>
  );
}

function LinkExistingModal({ onClose, onPick, exclude }: { onClose: () => void; onPick: (id: number) => void; exclude: Set<number> }) {
  const { data } = useLoad<Row[]>('/api/documents');
  const [q, setQ] = useState('');
  const rows = (data ?? []).filter((d) => !exclude.has(d.id) && `${d.display_name} ${d.original_filename} DOC-${d.id}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Link an existing document" onClose={onClose}>
      <input autoFocus placeholder="Search documents…" value={q} onChange={(e) => setQ(e.target.value)} className="wide" />
      <div className="pick-list">
        {rows.slice(0, 100).map((d) => (
          <button key={d.id} className="pick-row" onClick={() => onPick(d.id)}>
            <strong>{d.display_name}</strong>
            <span className="muted small"> DOC-{d.id} · {d.links.length} link(s) · {d.verified_by_operator ? 'verified' : 'not verified'}</span>
          </button>
        ))}
        {!rows.length && <p className="muted">No other documents.</p>}
      </div>
    </Modal>
  );
}
