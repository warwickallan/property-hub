import { useCallback, useEffect, useState } from 'react';
import { api, type Row } from './api';
import { fmtDate, fmtDateTime } from './util';
import { Dashboard, ActivitiesRegister } from './pages/Activities';
import { ActivityDetail, ActivityForm } from './pages/Activity';
import { EquipmentRegister, EquipmentDetail } from './pages/Equipment';
import { DocumentsLibrary } from './pages/Documents';
import { LocationDetail } from './pages/Location';
import { Reminders } from './pages/Reminders';
import { ActionsRegister } from './pages/Actions';
import { Inspections } from './pages/Inspections';
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

const NAV = [
  ['#/', 'Dashboard'],
  ['#/activities', 'Compliance Activities'],
  ['#/equipment', 'Equipment'],
  ['#/documents', 'Documents'],
  ['#/inspections', 'Inspections'],
  ['#/actions', 'Actions'],
  ['#/reminders', 'Reminders'],
];
const ADMIN_NAV = [
  ['#/admin/people', 'People / Users'],
  ['#/admin/core', 'Core Data'],
  ['#/admin/types', 'Compliance Types'],
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
      if (id) return <ActivityDetail id={id} />;
      return <ActivitiesRegister />;
    case 'equipment': return id ? <EquipmentDetail id={id} /> : <EquipmentRegister />;
    case 'documents': return <DocumentsLibrary />;
    case 'areas': case 'sites': case 'rooms':
      return id ? <LocationDetail kind={a.slice(0, -1) as 'area' | 'site' | 'room'} id={id} key={hash} /> : <AdminCoreData />;
    case 'inspections': return <Inspections />;
    case 'actions': return <ActionsRegister />;
    case 'reminders': return <Reminders />;
    case 'service-charges': return <ServiceCharges />;
    case 'admin':
      if (b === 'people') return <AdminPeople />;
      if (b === 'types') return <AdminTypes />;
      if (b === 'settings') return <AdminSettings />;
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
      <div className="brand"><a href="#/">PROPERTY HUB</a><span className="badge">Local demo · fictional data</span></div>
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
  const active = (h: string) => (h === '#/' ? hash === '#/' || hash === '#' : hash.startsWith(h));
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
