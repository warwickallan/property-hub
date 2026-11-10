// Back up or restore the *operational* Property Hub database and document store.
// Intended for use with bundled Node on an ordinary Windows user account.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';

const root = process.env.PH_PORTABLE_DATA_ROOT
  ? path.resolve(process.env.PH_PORTABLE_DATA_ROOT)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PropertyHub');
const live = path.join(root, 'data');
const backups = process.env.PH_PORTABLE_BACKUP_ROOT
  ? path.resolve(process.env.PH_PORTABLE_BACKUP_ROOT)
  : path.join(os.homedir(), 'Documents', 'Property Hub Backups');
const port = Number(process.env.PH_PORTABLE_PORT || 3001);
const action = process.argv[2];

function stamp() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
}
function filesIn(folder, prefix = '') {
  if (!fs.existsSync(folder)) return [];
  const items = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Symbolic links not allowed in backups: ' + entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) items.push(...filesIn(path.join(folder, entry.name), relative));
    else if (entry.isFile()) items.push(relative);
    else throw new Error('Unexpected filesystem object: ' + entry.name);
  }
  return items;
}
function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function verify(folder) {
  const manifestFile = path.join(folder, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error('Not a Property Hub backup: manifest.json not found.');
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (m.kind !== 'property-hub-data-backup' || m.version !== 1 || !Array.isArray(m.files))
    throw new Error('Not a recognised Property Hub backup format.');
  const data = path.join(folder, 'data');
  for (const file of m.files) {
    if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || file.path.includes('..') ||
        path.isAbsolute(file.path)) throw new Error('Invalid backup file path.');
    const target = path.resolve(data, file.path);
    if (!target.startsWith(path.resolve(data) + path.sep)) throw new Error('Path outside the backup.');
    if (!fs.existsSync(target) || digest(target) !== file.sha256) throw new Error('Backup checksum failed: ' + file.path);
  }
  if (!m.files.some((x) => x.path === 'propertyhub.db')) throw new Error('Backup does not contain the SQLite database.');
  const actual = filesIn(data).sort();
  const listed = m.files.map((x) => x.path).sort();
  if (actual.join('|') !== listed.join('|')) throw new Error('Backup has unexpected or missing files.');
  return m;
}
async function listening() {
  return await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { s.destroy(); resolve(false); }, 800);
    s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}
function makeBackup(label) {
  const dbPath = path.join(live, 'propertyhub.db');
  if (!fs.existsSync(dbPath)) throw new Error('There is no operational database to back up yet.');
  fs.mkdirSync(backups, { recursive: true });
  const dest = path.join(backups, label + '-' + stamp() + '-' + crypto.randomBytes(2).toString('hex'));
  fs.mkdirSync(dest, { recursive: true });
  const folder = path.join(dest, 'data');
  try {
    fs.cpSync(live, folder, { recursive: true, errorOnExist: false, force: true });
    const all = filesIn(folder);
    const manifest = {
      kind: 'property-hub-data-backup', version: 1,
      createdAt: new Date().toISOString(), source: 'operational', files: all.map((name) => ({
        path: name, sha256: digest(path.join(folder, name)),
      })),
    };
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
    verify(dest);
    return dest;
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

try {
  if (!['backup', 'restore', 'verify'].includes(action)) {
    throw new Error('Usage: data-manager.mjs backup | restore | verify <folder>');
  }
  if (await listening()) {
    throw new Error('Property Hub is running on port ' + port + '. Close its black console window before backing up or restoring.');
  }
  if (action === 'backup') {
    console.log('Backing up operational data and all uploaded documents...');
    const folder = makeBackup('PropertyHub');
    console.log('Backup complete and verified: ' + folder);
    console.log('Keep a second copy in a location approved by your organisation.');
  } else if (action === 'verify') {
    const folder = process.argv[3];
    if (!folder) throw new Error('Supply a backup folder.');
    const m = verify(path.resolve(folder));
    console.log('Backup verified: ' + m.files.length + ' file(s), created ' + m.createdAt);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let folder = process.argv[3];
    if (!folder) folder = await rl.question('Paste the FULL backup folder path and press Enter: ');
    folder = folder.trim().replace(/^"|"$/g, '');
    const m = verify(path.resolve(folder));
    console.log('Verified backup from ' + m.createdAt + ' containing ' + m.files.length + ' file(s).');
    console.log('WARNING: Restoring replaces the current operational Property Hub records AND documents.');
    console.log('The current records will be backed up automatically before replacement.');
    const answer = await rl.question('Type RESTORE to continue, or anything else to cancel: ');
    if (answer !== 'RESTORE') {
      console.log('Cancelled without changes.');
      rl.close();
      process.exit(0);
    }
    rl.close();
    const currentExists = fs.existsSync(path.join(live, 'propertyhub.db'));
    if (currentExists) console.log('Pre-restore backup: ' + makeBackup('Before-Restore'));
    const staged = path.join(root, '.restore-staging-' + crypto.randomBytes(4).toString('hex'));
    const old = path.join(root, '.restore-previous-' + crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(root, { recursive: true });
    try {
      fs.cpSync(path.join(path.resolve(folder), 'data'), staged, { recursive: true });
      if (fs.existsSync(live)) fs.renameSync(live, old);
      try {
        fs.renameSync(staged, live);
      } catch (e) {
        if (fs.existsSync(old)) fs.renameSync(old, live);
        throw e;
      }
      if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
      console.log('Restore complete. Start Property Hub normally.');
    } finally {
      if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true });
    }
  }
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exitCode = 1;
}
