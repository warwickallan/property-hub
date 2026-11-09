// Scheduling + statutory paperwork, UI only:
// A. PH-C012 defect: edit last work date -> calculated next due -> save -> pending, snapshot unchanged -> reload -> Recalculate -> new date.
// B. Gas Safety visit from the Activity: complete -> Awaiting Evidence (paperwork required) -> upload (not verification)
//    -> verify -> Close -> unchanged until Recalculate -> compliant. History: inspections vs calculation vs schedule changes.
import fs from 'node:fs';
import path from 'node:path';
import { wait } from './lib.mjs';

const ukDate = (iso) => iso.split('-').reverse().join('/');
function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12), tm = total - ty * 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, last))).toISOString().slice(0, 10);
}

export default async function p11(d, r, { tmpDir }) {
  const { page } = d;
  await d.go('#/');
  const { today } = await d.api('/api/status');
  const rowFor = async (ref) => {
    await d.go('#/');
    await d.clickText('button.tab', /^All/);
    await d.setVal('input[type=search]', ref);
    const t = await d.within('table.table tbody');
    await d.setVal('input[type=search]', '');
    return t;
  };
  const recalc = async () => { await d.clickText('button', /^Recalculate Compliance$/); await wait(1100); };

  // ---------- A. PH-C012 date edit ----------
  await recalc();
  const c12 = (await d.api('/api/activities')).find((a) => a.ref === 'PH-C012');
  const oldDue = c12.next_due_on;
  let row = await rowFor('PH-C012');
  r.ok(/Overdue \/ at risk/.test(row) && row.includes(ukDate(oldDue)), `PH-C012 Gas Safety starts Overdue, next due ${ukDate(oldDue)}`);
  await d.go(`#/activities/${c12.id}`);
  let t = await d.text();
  r.ok(/Last work performed/.test(t) && /Last inspection closed/.test(t) && /Inspection interval/.test(t) && /Calculated next due/.test(t) && /Next-due override/.test(t) && /Effective next due/.test(t),
    'Activity shows last work, last closure, interval, calculated next due, override and effective next due separately');

  await d.go(`#/activities/${c12.id}/edit`);
  await d.setVal('[aria-label="Last done"]', today);
  const newDue = addMonths(today, 12);
  r.ok((await d.within('[data-testid="calculated-next-due"]')).includes(ukDate(newDue)), `Edit form shows calculated next due ${ukDate(newDue)}`);
  r.ok(!(await page.$('[aria-label="Next due"]')), 'Next due is calculated, not a free field, unless Override is ticked');
  await d.shot('20-c012-edit-schedule', { fullPage: false });
  await d.clickText('button', /^Save activity$/);
  await wait(700);
  t = await d.text();
  r.ok(/Saved\. Changes pending/.test(t) && /Changes pending recalculation/.test(t), 'Save confirms and header flags Changes pending');
  r.ok(t.includes(ukDate(newDue)) && /last work \+ 12 months/.test(t), 'Overview shows the new calculated next due');
  r.ok(/Click Recalculate Compliance to update this status/.test(t), 'Overview explains the snapshot is stale until Recalculate');
  row = await rowFor('PH-C012');
  r.ok(/Overdue \/ at risk/.test(row), 'Dashboard status unchanged before Recalculate');
  await d.go(`#/activities/${c12.id}`);
  r.ok((await d.text()).includes(ukDate(newDue)), 'Reload shows the persisted next due');
  await recalc();
  row = await rowFor('PH-C012');
  r.ok(row.includes(ukDate(newDue)) && !row.includes(ukDate(oldDue)) && !/Overdue/.test(row), `After Recalculate the Dashboard shows ${ukDate(newDue)} and no longer Overdue`);
  r.ok(/Unknown \/ missing/.test(row), 'Without verified paperwork for the new date it is Unknown / missing (not green)');
  await d.shot('21-c012-after-recalculate', { fullPage: false });

  // ---------- B. Gas Safety visit with required paperwork ----------
  await d.go(`#/activities/${c12.id}`);
  await d.clickText('button', /^Start inspection \/ visit$/);
  await wait(800);
  const visitId = Number((page.url().match(/visits\/(\d+)/) || [])[1]);
  t = await d.text();
  r.ok(visitId > 0 && t.includes('PH-C012') && /GAS requires verified paperwork/.test(t), 'Visit started from the activity; paperwork requirement shown');
  await d.setVal('[aria-label="Provider"]', 'Demo Gas Engineer Ltd (fictional)');
  await d.clickText('button', /^Complete Inspection…$/);
  const proposed = await d.within('[data-testid="proposed-next-due"]');
  r.ok(proposed.includes(ukDate(newDue)), 'Proposed next due = performed date + interval');
  await d.clickText('.modal button', /^Record Inspection Complete$/);
  await wait(800);
  t = await d.text();
  r.ok(/Awaiting Evidence/.test(await d.within('.chain')) && /Close is blocked/.test(t) && /GAS requires evidence/.test(t), 'Completed without paperwork: Awaiting Evidence, Close blocked');
  const cert = path.join(tmpDir, 'gas-safety-record-demo.pdf');
  fs.writeFileSync(cert, `%PDF-1.4\n% fictional gas safety record ${Date.now()}\n%%EOF\n`);
  await (await page.$('[data-testid="upload-inspection"]')).uploadFile(cert);
  await wait(1200);
  t = await d.text();
  r.ok(/linked but not yet marked Reviewed\/Verified/.test(t) && /Awaiting Evidence/.test(await d.within('.chain')), 'Upload alone is not verification (still Awaiting Evidence)');
  await page.$eval('[aria-label="Verify gas-safety-record-demo.pdf"]', (c) => c.click());
  await wait(1200);
  t = await d.text();
  r.ok(/All closure conditions are met/.test(t), 'After verifying the certificate the visit is ready to close');
  await d.shot('22-visit-ready-to-close', { fullPage: false });
  await d.clickText('button', /^Close Inspection$/);
  await wait(700);
  r.ok(/Closed/.test(await d.within('.chain')) && /Inspection closed/.test(await d.text()), 'Inspection closed');
  row = await rowFor('PH-C012');
  r.ok(/Unknown \/ missing/.test(row), 'Activity status unchanged until Recalculate');
  await recalc();
  row = await rowFor('PH-C012');
  r.ok(/Up to date/.test(row), 'After Recalculate PH-C012 is compliant (closed visit with verified certificate)');

  // ---------- C. History ----------
  await d.go(`#/activities/${c12.id}?tab=history`);
  t = await d.within('main');
  r.ok(/Inspections \/ visits \(latest first\)/.test(t) && /Closed/.test(t), 'Inspection history is the default history view, latest first');
  await d.shot('23-inspection-history', { fullPage: false });
  await d.clickText('button.tab', /^Calculation history/);
  t = await d.within('main');
  r.ok(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/.test(t) && /Runs/.test(t), 'Calculation history uses full timestamps and a run count');
  await d.shot('24-calculation-history', { fullPage: false });
  await d.clickText('button.tab', /^Schedule changes/);
  t = await d.within('main');
  r.ok(/Manual edit/.test(t) && /Visit completed/.test(t), 'Schedule changes log the manual edit and the visit');
}
