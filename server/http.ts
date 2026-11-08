// Small HTTP helpers: typed errors, input coercion, SQLite error translation.
import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (what: string) => new HttpError(404, `${what} not found`);

type Handler = (req: Request, res: Response) => unknown;
/** Wraps a sync/async handler so thrown errors reach the error middleware. */
export const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out instanceof Promise) out.catch(next);
  } catch (e) {
    next(e);
  }
};

export function reqStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} is required`);
  return v.trim();
}
export function optStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
export function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${field} must be a whole number`);
  return n;
}
export function reqInt(v: unknown, field: string): number {
  const n = optInt(v, field);
  if (n === null) throw bad(`${field} is required`);
  return n;
}
export function bool01(v: unknown, dflt = 1): number {
  if (v === undefined || v === null || v === '') return dflt;
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}
export const idParam = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n)) throw bad('Invalid id');
  return n;
};

/** Translates thrown errors (incl. SQLite constraints) into readable JSON responses. */
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const col = /UNIQUE constraint failed: \w+\.(\w+)/.exec(e.message ?? '')?.[1];
    return res.status(409).json({ error: col ? `That ${col.replace(/_/g, ' ')} is already in use` : 'Duplicate record' });
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(409).json({ error: 'This record is linked to other records (or references a missing record). Archive it instead, or remove the links first.' });
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK' || code === 'SQLITE_CONSTRAINT_NOTNULL') {
    return res.status(400).json({ error: `Invalid value: ${e.message}` });
  }
  if (code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 20 MB)' });
  if (err instanceof Error && /must be a valid date/.test(err.message)) return res.status(400).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: e?.message ?? 'Internal error' });
}
