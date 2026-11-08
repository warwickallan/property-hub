// npm run seed  -> deletes the local demo database + uploads/outbox and re-seeds fictional data.
import fs from 'node:fs';
import { openDb } from './db.js';
import { ensureReferenceData, seedDemo } from './seed.js';
import { londonToday } from './dates.js';
import { DATA_DIR, DB_FILE, OUTBOX_DIR, UPLOADS_DIR } from './config.js';

if (process.argv.includes('--reset')) {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
  fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  console.log('Removed local demo database, uploads and outbox.');
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_FILE);
ensureReferenceData(db);
console.log(seedDemo(db, UPLOADS_DIR, londonToday(new Date())) ? 'Seeded fictional demo data.' : 'Database already has data; nothing seeded.');
db.close();
