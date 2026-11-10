// Thin fetch wrapper for the local Express API.
export type Row = Record<string, any>;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  // Notify the header so the "changes pending" indicator refreshes after any write.
  if (method !== 'GET') window.dispatchEvent(new Event('ph:changed'));
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => call<T>('GET', url),
  post: <T = any>(url: string, body?: unknown) => call<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body: unknown) => call<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown) => call<T>('PATCH', url, body),
  del: <T = any>(url: string) => call<T>('DELETE', url),
};

export interface Core {
  areas: Row[];
  sites: Row[];
  rooms: Row[];
  users: Row[];
  types: Row[];
  equipment: Row[];
}

/** POST to an export endpoint and save the returned CSV under `filename`. */
export async function downloadCsv(url: string, body: unknown, filename: string) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? 'Export failed');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
