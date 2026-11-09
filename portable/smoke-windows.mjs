// End-to-end smoke test for extracted Windows portable ZIP: no system node/npm used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const folder = path.resolve(process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const exe = path.join(folder, 'runtime', 'node.exe');
const app = path.join(folder, 'app');
const manager = path.join(folder, 'portable', 'data-manager.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-portable-smoke-'));
const root = path.join(tmp, 'user-data');
const backupRoot = path.join(tmp, 'backups');
const port = 34127;
const base = 'http://127.0.0.1:' + port;
const env = { ...process.env, PH_PORTABLE_DATA_ROOT: root, PH_PORTABLE_BACKUP_ROOT: backupRoot,
  PH_PORTABLE_PORT: String(port), PORT: String(port), NODE_ENV: 'production' };
let passed = 0;
function ok(value, description) {
  if (!value) throw new Error('FAIL: ' + description);
  passed++;
  console.log('PASS ' + description);
}
function runManager(args, input) {
  const x = spawnSync(exe, [manager, ...args], { env, input, encoding: 'utf8', timeout: 15000 });
  if (x.status !== 0) throw new Error('manager ' + args.join(' ') + ': ' + x.stdout + '\n' + x.stderr);
  return x.stdout;
}
async function wait() {
  for(let n=0;n<120;n++){
    try { const r=await fetch(base + '/api/status'); if(r.ok) return; }catch{}
    await new Promise((done)=>setTimeout(done,250));
  }
  throw new Error('server not ready');
}
async function start(demo){
  const log=[];
  const child=spawn(exe, ['--import', 'tsx', './server/index.ts'], {
    cwd:app, env:{...env,PH_DATA_DIR:path.join(root,demo?'demo-data':'data'),PH_DEMO_DATA:demo?'1':'0'},
    stdio:['ignore','pipe','pipe']
  });
  child.stdout.on('data',c=>log.push(String(c)));
  child.stderr.on('data',c=>log.push(String(c)));
  try { await wait(); }catch(e){child.kill(); throw new Error(e.message+' logs: '+log.join('')); }
  return child;
}
async function stop(child){
  child.kill();
  await new Promise(resolve=>child.once('exit',resolve));
}
async function req(uri,options={}){
  const r=await fetch(base+uri,options);
  const body=await r.json();
  if(!r.ok) throw new Error(uri + ' returned ' + r.status + ' ' + JSON.stringify(body));
  return body;
}
try {
  ok(fs.existsSync(exe),'Bundled Node executable is present');
  ok(fs.existsSync(path.join(app,'node_modules','better-sqlite3','build','Release','better_sqlite3.node')),'Windows SQLite binary included');
  ok(fs.existsSync(path.join(app,'dist','index.html')),'Built frontend included');
  let server=await start(false);
  let core=await req('/api/core');
  ok(core.areas.length===0 && core.sites.length===0,'Clean launcher creates no fictional properties');
  ok(core.types.length===6 && core.types.some(t=>t.code==='RPI'),'Five statutory types plus the routine inspection type in a clean database');
  const cls=await req('/api/checklists');
  ok(cls.filter(c=>c.type_code==='RPI').map(c=>c.item_count).sort().join(',')==='4,5,6,7,8','Five routine checklists (8/4/5/6/7 questions) in a clean database');
  const res=await fetch(base+'/');
  ok(res.ok && (await res.text()).includes('<div id="root">'),'Built React UI served without npm');
  await req('/api/areas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Portable Smoke Test Area'})});
  core=await req('/api/core');
  ok(core.areas.length===1,'Data writes persist in operational SQLite');
  await stop(server);
  const backupMsg=runManager(['backup']);
  ok(backupMsg.includes('Backup complete and verified'),'Backup created and SHA-256 verified');
  const backupFolder=fs.readdirSync(backupRoot).map(x=>path.join(backupRoot,x))[0];
  ok(runManager(['verify',backupFolder]).includes('Backup verified'),'Standalone backup verifier works');
  server=await start(false);
  const area=await req('/api/core');
  ok(area.areas.length===1,'Operational data survives restart');
  await req('/api/areas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Temporary Area To Remove'})});
  await stop(server);
  const restoreMsg=runManager(['restore',backupFolder],'RESTORE\n');
  ok(restoreMsg.includes('Restore complete'),'Interactive restore completes with confirmed input');
  server=await start(false);
  core=await req('/api/core');
  ok(core.areas.length===1,'Restore reverts newer records and preserves backed-up data');
  await stop(server);
  server=await start(true);
  core=await req('/api/core');
  ok(core.sites.length===10,'Separate Demo launcher seeds ten fictional sites');
  // V2: full visit lifecycle on a demo Gas activity through the bundled runtime (paperwork required).
  const status=await req('/api/status');
  ok(/^\d+\.\d+\.\d+$/.test(status.version),'Version reported: '+status.version);
  const post=(u,b)=>req(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
  const gas=(await req('/api/activities')).find(a=>a.ref==='PH-C012');
  const visit=await post('/api/visits',{activity_id:gas.id,provider_name:'Smoke test engineer (fictional)'});
  const done=await post('/api/visits/'+visit.id+'/complete',{outcome:'complete'});
  ok(done.status==='awaiting_evidence' && done.blockers.some(b=>b.code==='evidence'),'Completed visit awaits required evidence');
  const blocked=await fetch(base+'/api/visits/'+visit.id+'/close',{method:'POST'});
  ok(blocked.status===409,'Close refused without verified paperwork');
  const fd=new FormData();
  fd.append('file',new Blob(['%PDF-1.4 smoke certificate '+Date.now()],{type:'application/pdf'}),'smoke-cert.pdf');
  fd.append('entity_kind','inspection');fd.append('entity_id',String(visit.id));
  const doc=await (await fetch(base+'/api/documents',{method:'POST',body:fd})).json();
  await req('/api/documents/'+doc.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({verified_by_operator:true})});
  const closed=await post('/api/visits/'+visit.id+'/close',{});
  const after=await req('/api/activities/'+gas.id);
  ok(closed.status==='closed' && after.last_done_on===status.today && after.next_due_on>status.today,'Visit closed after verifying evidence; schedule updated');
  ok((await req('/api/status')).pending===true,'Changes pending: no automatic recalculation');
  await stop(server);
  // Optional upgrade test: start the PREVIOUS release on a throwaway folder, then this release on the same database.
  const prevIdx=process.argv.indexOf('--upgrade-from');
  if(prevIdx>0){
    const prev=path.resolve(process.argv[prevIdx+1]);
    const upgradeDir=path.join(root,'upgrade-data');
    const old=spawn(path.join(prev,'runtime','node.exe'),['--import','tsx','./server/index.ts'],{cwd:path.join(prev,'app'),
      env:{...env,PH_DATA_DIR:upgradeDir,PH_DEMO_DATA:'1'},stdio:['ignore','pipe','pipe']});
    await wait();
    const oldActs=await req('/api/activities');
    const oldC12=oldActs.find(a=>a.ref==='PH-C012');
    ok(oldC12 && oldC12.next_due_override===undefined,'Previous release created a pre-upgrade database (no override field)');
    await stop(old);
    const upgraded=spawn(exe,['--import','tsx','./server/index.ts'],{cwd:app,env:{...env,PH_DATA_DIR:upgradeDir,PH_DEMO_DATA:'0'},stdio:['ignore','pipe','pipe']});
    const upLog=[];
    upgraded.stdout.on('data',c=>upLog.push(String(c)));
    upgraded.stderr.on('data',c=>upLog.push(String(c)));
    try { await wait(); } catch(e) { await stop(upgraded); throw new Error(e.message+' (upgraded release) logs: '+upLog.join('')); }
    const newC12=(await req('/api/activities')).find(a=>a.ref==='PH-C012');
    ok(newC12.next_due_on===oldC12.next_due_on && newC12.last_done_on===oldC12.last_done_on && newC12.next_due_override===0,
      'Upgrade keeps existing dates and classifies the schedule as calculated');
    ok((await req('/api/core')).sites.length===10,'Upgrade keeps all existing records');
    const upVisits=await req('/api/visits');
    const legacy=upVisits.filter(v=>v.needs_review);
    ok(legacy.length>=2 && legacy.every(v=>/^PH-I/.test(v.ref)),'Older routine inspections preserved as visits and flagged for review ('+legacy.map(v=>v.ref).join(', ')+')');
    ok((await req('/api/actions')).every(a=>/^PH-X/.test(a.ref)),'Older actions preserved as remedials');
    await stop(upgraded);
  }
  const prodDb=path.join(root,'data','propertyhub.db');
  ok(fs.existsSync(prodDb) && fs.existsSync(path.join(root,'demo-data','propertyhub.db')),'Real and Demo databases are independent');
  console.log('SMOKE SUCCESS: '+passed+' checks, folder='+folder);
} catch(e) {
  console.error(e.stack||String(e));
  process.exitCode=1;
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
