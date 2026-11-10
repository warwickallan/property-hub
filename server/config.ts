import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.PH_DATA_DIR ?? path.join(ROOT, 'data'));
export const DB_FILE = path.join(DATA_DIR, 'propertyhub.db');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
export const DIST_DIR = path.join(ROOT, 'dist');
export const PORT = Number(process.env.PORT ?? 3001);
// Localhost only: this prototype has no authentication and must not be exposed on a network.
export const HOST = '127.0.0.1';

import fs from 'node:fs';
/** App version from package.json (shown in the header so operators can identify the portable build). */
export const APP_VERSION: string = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? ''; } catch { return ''; }
})();
