import { useCallback, useEffect, useState } from 'react';
import { api, type Row } from './api';
import { fmtDate, fmtDateTime } from './util';
import { Dashboard, ActivitiesRegister } from './pages/Activities';
import { ActivityDetail, ActivityForm } from './pages/Activity';
import { EquipmentRegister, EquipmentDetail } from './pages/Equipment';
import { DocumentsLibrary } from './pages/Documents';
import { LocationDetail } from './pages/Location';
import { Reminders } from './pages/Reminders';
import { RemedialsRegister, RemedialDetail } from './pages/Actions';
import { VisitsRegister, VisitDetail } from './pages/Visits';
import { ChecklistsAdmin, ChecklistEditor } from './pages/Checklists';
import { SiteFrontSheetPrint } from './pages/Print';
import { AdminPeople, AdminCoreData, AdminTypes, AdminSettings, ServiceCharges } from './pages/Admin';

function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const f = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}

// Everyday work. Compliance Activities (scheduled configuration) live under Admin / Setup.
const NAV = [
  ['#/', 'Dashboard'],
  ['#/visits', 'Inspections / Visits'],
  ['#/remedials', 'Remedials'],
  ['#/equipment', 'Equipment'],
  ['#/documents', 'Documents'],
  ['#/reminders', 'Reminders'],
];
const ADMIN_NAV = [
  ['#/admin/people', 'People / Users'],
  ['#/admin/property', 'Property Details'],
  ['#/admin/types', 'Compliance Types'],
  ['#/admin/checklists', 'Checklists'],
  ['#/admin/activities', 'Compliance Activities'],
  ['#/admin/settings', 'Settings'],
];

function route(hash: string) {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [a, b, c] = parts;
  const id = b && /^\d+$/.test(b) ? Number(b) : null;
  switch (a) {
    case undefined: return <Dashboard />;
    case 'activities':
      if (b === 'new') return <ActivityForm />;
      if (id && c === 'edit') return <ActivityForm id={id} />;
      if (id) return <ActivityDetail id={id} key={hash} />;
      return <ActivitiesRegister />;
    case 'equipment': return id ? <EquipmentDetail id={id} /> : <EquipmentRegister />;
    case 'documents': return <DocumentsLibrary />;
    case 'areas': case 'sites': case 'rooms':
      if (a === 'sites' && id && c === 'print') return <SiteFrontSheetPrint id={id} />;
      return id ? <LocationDetail kind={a.slice(0, -1) as 'area' | 'site' | 'room'} id={id} key={hash} /> : <AdminCoreData />;
    case 'visits': case 'inspections': return id ? <VisitDetail id={id} key={id} /> : <VisitsRegister />;
    case 'remedials': case 'actions': return id ? <RemedialDetail id={id} key={id} /> : <RemedialsRegister />;
    case 'reminders': return <Reminders />;
    case 'service-charges': return <ServiceCharges />;
    case 'admin':
      if (b === 'people') return <AdminPeople />;
      if (b === 'types') return <AdminTypes />;
      if (b === 'settings') return <AdminSettings />;
      if (b === 'activities') return <ActivitiesRegister />;
      if (b === 'checklists') return c && /^\d+$/.test(c) ? <ChecklistEditor id={Number(c)} key={c} /> : <ChecklistsAdmin />;
      return <AdminCoreData />;
    default: return <p>Page not found. <a href="#/">Go to Dashboard</a></p>;
  }
}

function Header() {
  const [status, setStatus] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.get('/api/status').then(setStatus, (e) => setErr(e.message)), []);
  useEffect(() => {
    load();
    window.addEventListener('ph:changed', load);
    return () => window.removeEventListener('ph:changed', load);
  }, [load]);

  const recalc = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/recalculate');
      window.dispatchEvent(new Event('ph:recalculated'));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="header">
      <div className="brand"><a href="#/">PROPERTY HUB</a><span className="badge">Local · single operator</span>{status?.version && <span className="app-version">v{status.version}</span>}</div>
      <div className="header-right">
        <div className="calc-info">
          {status?.lastRun ? <>Last calculated <strong>{fmtDateTime(status.lastRun.createdAt)}</strong></> : <strong>Not yet calculated</strong>}
          {status?.pending && <span className="pending" data-testid="pending">● Changes pending recalculation</span>}
          {status && <span className="muted small"> Today (Europe/London): {fmtDate(status.today)}</span>}
        </div>
        <button className="btn-primary" onClick={recalc} disabled={busy}>{busy ? 'Recalculating…' : 'Recalculate Compliance'}</button>
        {err && <span className="error small">{err}</span>}
      </div>
    </header>
  );
}

export function App() {
  const hash = useHash();
  // Bumping this remounts the page after a recalculation so it shows fresh snapshots.
  const [gen, setGen] = useState(0);
  useEffect(() => {
    const f = () => setGen((g) => g + 1);
    window.addEventListener('ph:recalculated', f);
    return () => window.removeEventListener('ph:recalculated', f);
  }, []);
  if (/^#\/sites\/\d+\/print/.test(hash)) return <main className="print-main" key={gen}>{route(hash)}</main>;
  const alias: Record<string, string> = { '#/inspections': '#/visits', '#/actions': '#/remedials', '#/activities': '#/admin/activities', '#/admin/core': '#/admin/property' };
  const norm = Object.entries(alias).reduce((h, [from, to]) => (h.startsWith(from) ? to + h.slice(from.length) : h), hash);
  const active = (h: string) => (h === '#/' ? norm === '#/' || norm === '#' : norm.startsWith(h));
  return (
    <div className="layout">
      <Header />
      <nav className="sidebar">
        <ul>
          {NAV.map(([h, l]) => <li key={h}><a className={active(h) ? 'active' : ''} href={h}>{l}</a></li>)}
          <li><a className={`subdued ${active('#/service-charges') ? 'active' : ''}`} href="#/service-charges">Service Charges <em>(Phase 2)</em></a></li>
        </ul>
        <div className="admin-nav">
          <div className="admin-title">⚙ Admin / Setup</div>
          <ul>
            {ADMIN_NAV.map(([h, l]) => <li key={h}><a className={active(h) ? 'active' : ''} href={h}>{l}</a></li>)}
          </ul>
        </div>
      </nav>
      <main className="main" key={gen}>{route(hash)}</main>
    </div>
  );
}
