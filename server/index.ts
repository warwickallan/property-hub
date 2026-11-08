import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureReferenceData, seedDemo } from './seed.js';
import { londonToday } from './dates.js';
import { DATA_DIR, DB_FILE, DIST_DIR, HOST, OUTBOX_DIR, PORT, UPLOADS_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_FILE);
ensureReferenceData(db);
// Portable clean mode must never silently populate operational records with demo properties.
// Source-development default retains the existing demo experience; the Windows portable
// launcher explicitly sets PH_DEMO_DATA=0 for real work, or =1 for a separate demo folder.
if (process.env.PH_DEMO_DATA !== '0') {
  if (seedDemo(db, UPLOADS_DIR, londonToday(new Date()))) console.log('Seeded fictional demo data (2 Areas, 10 Sites).');
} else {
  const count = (db.prepare('SELECT COUNT(*) AS count FROM sites').get() as { count: number }).count;
  if (count === 0) console.log('Clean start: no demonstration properties have been added.');
}

const app = createApp({ db, uploadsDir: UPLOADS_DIR, outboxDir: OUTBOX_DIR });

// Production-like mode: serve the built UI if present (npm start). In dev, Vite serves the UI.
if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(express.static(DIST_DIR));
  app.get('*', (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

app.listen(PORT, HOST, () => {
  console.log(`Property Hub API listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) console.log(`Open http://localhost:${PORT}`);
});
