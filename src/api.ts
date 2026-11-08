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
