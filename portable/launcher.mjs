// Property Hub portable Windows launcher. Node is bundled: no Node/npm installation required.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'app');
const demo = process.argv.includes('--demo');
const appData = process.env.PH_PORTABLE_DATA_ROOT
  ? path.resolve(process.env.PH_PORTABLE_DATA_ROOT)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PropertyHub');
const dataDir = path.join(appData, demo ? 'demo-data' : 'data');
const port = Number(process.env.PH_PORTABLE_PORT || 3001);
const url = 'http://127.0.0.1:' + port;

function canConnect() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => { sock.destroy(); resolve(false); }, 500);
    sock.once('connect', () => { clearTimeout(timeout); sock.destroy(); resolve(true); });
    sock.once('error', () => { clearTimeout(timeout); resolve(false); });
  });
}

if (process.platform !== 'win32') {
  console.error('This portable distribution is built for Windows x64 only.');
  process.exit(2);
}
if (await canConnect()) {
  console.error('Port ' + port + ' is already in use. Close the existing Property Hub window first.');
  process.exit(3);
}
if (!fs.existsSync(path.join(appDir, 'dist', 'index.html'))) {
  console.error('The packaged application files are missing. Re-extract the complete ZIP.');
  process.exit(4);
}
fs.mkdirSync(dataDir, { recursive: true });

console.log('');
console.log('PROPERTY HUB — ' + (demo ? 'FICTIONAL DEMO' : 'CLEAN OPERATIONAL DATA'));
console.log('App files: ' + appDir);
console.log('Saved data: ' + dataDir);
console.log('Address: ' + url);
console.log('Keep this window open while using Property Hub. Close it to stop the app.');
console.log('');

const child = spawn(process.execPath, ['--import', 'tsx', './server/index.ts'], {
  cwd: appDir,
  env: {
    ...process.env,
    PH_DATA_DIR: dataDir,
    PH_DEMO_DATA: demo ? '1' : '0',
    PORT: String(port),
    NODE_ENV: 'production',
  },
  stdio: 'inherit',
  windowsHide: false,
});

let finished = false;
child.once('error', (error) => {
  console.error('Property Hub could not start:', error.message);
  process.exitCode = 10;
});
child.once('exit', (code) => {
  finished = true;
  console.log('\nProperty Hub stopped (exit code ' + String(code) + ').');
  process.exitCode = code || 0;
});
for (let i = 0; i < 60 && !finished; i++) {
  if (await canConnect()) {
    console.log('Property Hub is ready. Opening your default browser...');
    try {
      const open = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        stdio: 'ignore', detached: true, windowsHide: true,
      });
      open.on('error', () => console.log('Open ' + url + ' in your browser.'));
      open.unref();
    } catch {
      console.log('Open ' + url + ' in your browser.');
    }
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!finished && !await canConnect()) {
  console.error('Server did not become ready. Review the messages above.');
  child.kill();
  process.exitCode = 11;
}
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
