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
if (seedDemo(db, UPLOADS_DIR, londonToday(new Date()))) console.log('Seeded fictional demo data (2 Areas, 10 Sites).');

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
