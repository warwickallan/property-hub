import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** ISO yyyy-mm-dd (or ISO timestamp) -> dd/mm/yyyy. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const STATUS_LABEL: Record<string, string> = {
  green: 'Up to date',
  amber: 'Due soon',
  red: 'Overdue / at risk',
  grey: 'Unknown / missing',
  na: 'Not applicable',
};

export const LEVEL_LABEL: Record<string, string> = { area: 'Area', site: 'Site', room: 'Room' };

/** Load a URL; re-load when `reload()` is called or deps change. */
export function useLoad<T = any>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    api.get<T>(url).then(
      (d) => live && (setData(d), setError(null)),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload, setData };
}

export function navigate(hash: string) {
  window.location.hash = hash;
}

export function locationLabel(a: Record<string, any>): string {
  if (a.location_level === 'room') return `${a.room_code} ${a.room_name}`;
  if (a.location_level === 'site') return 'Whole site';
  return 'Whole area';
}

/** Today's calendar date in Europe/London as yyyy-mm-dd. */
export function londonToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

// Same calendar arithmetic as the server (single source of truth, month-end clamped).
export { addMonths } from '../server/dates';

/** Full timestamp in Europe/London including seconds, so separate runs are distinguishable. */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Query parameters after '?' in the hash route. */
export function hashParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '');
}
