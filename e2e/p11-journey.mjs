// P1.1 journey, UI only:
// A. PH-C012 operator defect: edit last done -> derived next due -> save -> pending, snapshot unchanged -> reload -> Recalculate -> new date, not Overdue.
// B. Record a Gas Safety check from the Activity, attach + verify certificate -> history -> unchanged until Recalculate -> green.
// C. History: inspection history default, calculation history collapsed with full timestamps; amendment is traceable.
// D. Inspections page: Compliance Inspection / Check via cascading picker; unverified certificate never goes green.
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
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

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
  await d.go('#/');
  await recalc();
  const c12 = (await d.api('/api/activities')).find((a) => a.ref === 'PH-C012');
  const oldDue = c12.next_due_on;
  let row = await rowFor('PH-C012');
  r.ok(/Overdue \/ at risk/.test(row) && row.includes(ukDate(oldDue)), `PH-C012 Gas Safety starts Overdue, next due ${ukDate(oldDue)}`);

  await d.go(`#/activities/${c12.id}/edit`);
  await d.setVal('[aria-label="Last done"]', today);
  const newDue = addMonths(today, 12);
  const calc = await d.within('[data-testid="calculated-next-due"]');
  r.ok(calc.includes(ukDate(newDue)), `Edit form shows calculated next due ${ukDate(newDue)} = last done + 12 months`);
  r.ok(!(await page.$('[aria-label="Next due"]')), 'Next due is calculated, not a free field, unless Override is ticked');
  await d.shot('20-c012-edit-schedule', { fullPage: false });
  await d.clickText('button', /^Save activity$/);
  await wait(700);
  let t = await d.text();
  r.ok(/Saved\. Changes pending/.test(t) && /Changes pending recalculation/.test(t), 'Save confirms and header flags Changes pending');
  r.ok(t.includes(ukDate(newDue)) && /calculated: last done \+ 12 months/.test(t), 'Overview shows the new calculated next due');
  r.ok(/Click Recalculate Compliance to update this status/.test(t), 'Overview explains the snapshot is stale until Recalculate');
  row = await rowFor('PH-C012');
  r.ok(/Overdue \/ at risk/.test(row), 'Dashboard status unchanged before Recalculate');
  await d.go(`#/activities/${c12.id}`);
  r.ok((await d.text()).includes(ukDate(newDue)), 'Reload shows the persisted next due');
  await recalc();
  row = await rowFor('PH-C012');
  r.ok(row.includes(ukDate(newDue)) && !row.includes(ukDate(oldDue)) && !/Overdue/.test(row), `After Recalculate the Dashboard shows ${ukDate(newDue)} and no longer Overdue`);
  r.ok(/Unknown \/ missing/.test(row), 'Without a current-cycle certificate it shows Unknown / missing (not green)');
  await d.shot('21-c012-after-recalculate', { fullPage: false });

  // ---------- B. Record Gas Safety check from the Activity ----------
  const cert = path.join(tmpDir, 'gas-safety-record-demo.pdf');
  fs.writeFileSync(cert, `%PDF-1.4\n% fictional gas safety record ${Date.now()}\n%%EOF\n`);
  await d.go(`#/activities/${c12.id}`);
  await d.clickText('a.btn', /^Record Inspection \/ Check$/);
  t = await d.text();
  r.ok(/Record Inspection \/ Check/.test(t) && /PH-C012/.test(t) && /GAS — Gas Safety/.test(t), 'Check form inherits activity type and location');
  await d.selectByText('[aria-label="Check inspector"]', /Team Leader North/);
  await d.setVal('[aria-label="Provider"]', 'Demo Gas Engineer Ltd (fictional)');
  await d.setVal('[aria-label="Check notes"]', 'Annual gas safety check, all appliances safe (demo)');
  await d.clickText('label', /^Upload new file$/);
  await (await page.$('[aria-label="Certificate file"]')).uploadFile(cert);
  await d.setVal('[aria-label="Certificate valid until"]', newDue);
  await page.$eval('[aria-label="Verify certificate"]', (c) => c.click());
  r.ok((await d.within('[data-testid="proposed-next-due"]')).includes(ukDate(newDue)), 'Proposed next due = performed date + interval');
  await d.shot('22-record-check-form');
  await d.clickText('button', /^Save inspection \/ check$/);
  await wait(800);
  t = await d.text();
  r.ok(/Inspection \/ check recorded/.test(t) && /Inspection \/ check history \(latest first\)/.test(t), 'Saved check opens the Inspection / Check history');
  const hist = await d.within('.card table.table tbody');
  r.ok(/PH-K\d{3}/.test(hist) && /gas-safety-record-demo/.test(hist) && /verified/.test(hist), 'New check appears first with its verified certificate');
  r.ok(/Changes pending recalculation/.test(t), 'Recording the check flags Changes pending');
  row = await rowFor('PH-C012');
  r.ok(/Unknown \/ missing/.test(row), 'Status unchanged until Recalculate');
  await recalc();
  row = await rowFor('PH-C012');
  r.ok(/Up to date/.test(row), 'After Recalculate PH-C012 is green (verified current certificate)');

  // ---------- C. History views + amendment ----------
  await d.go(`#/activities/${c12.id}?tab=history`);
  await d.shot('23-check-history');
  await d.clickText('button.tab', /^Calculation history/);
  t = await d.within('main');
  r.ok(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/.test(t) && /Runs/.test(t), 'Calculation history uses full timestamps with seconds and a run count');
  const groups = await page.$$eval('main .card table.table tbody tr', (rows) => rows.length);
  const runs = (await d.api(`/api/activities/${c12.id}/history`)).snapshots.length;
  r.ok(groups <= runs && groups >= 3, `Calculation history collapses ${runs} runs into ${groups} distinct results`);
  await d.shot('24-calculation-history', { fullPage: false });
  await d.clickText('button.tab', /^Inspection \/ Check history/);
  await d.clickText('a', /^Amend…$/);
  r.ok(/You are correcting PH-K/.test(await d.text()), 'Amend opens a correction form explaining the original is kept');
  await d.setVal('[aria-label="Performed on"]', addDays(today, -1));
  await d.clickText('button', /^Save amendment$/);
  r.ok(/Give the reason for this amendment/.test(await d.text()), 'Amendment requires a reason');
  await d.setVal('[aria-label="Amendment reason"]', 'Engineer record shows the visit was the day before (demo)');
  await d.clickText('button', /^Save amendment$/);
  await wait(700);
  t = await d.within('main');
  r.ok(/Amendment recorded/.test(t) && /Superseded by PH-K/.test(t) && /Amends PH-K/.test(t), 'History shows the superseded original and the amendment with its reason');
  await d.shot('25-amended-history');
  await d.clickText('button.tab', /^Schedule changes/);
  t = await d.within('main');
  r.ok(/Manual edit/.test(t) && /Check recorded/.test(t) && /Amendment/.test(t), 'Schedule changes log the manual edit, the check and the amendment');

  // ---------- D. Compliance check from the Inspections page ----------
  await d.go('#/inspections');
  await d.clickText('button', /^\+ Start inspection$/);
  r.ok(/Routine Property Inspection/.test(await d.within('.modal')) && /Compliance Inspection \/ Check/.test(await d.within('.modal')), 'Start offers Routine or Compliance inspection');
  await d.shot('26-start-chooser', { fullPage: false });
  await d.clickText('.modal button.choice', /^Compliance Inspection \/ Check/);
  await d.selectByText('.modal [aria-label="Area"]', /PH-A001/);
  await d.selectByText('.modal [aria-label="Site"]', /PH-S004/);
  await d.selectByText('.modal [aria-label="Picker type"]', /^GAS/);
  const picks = await page.$$eval('.modal table.table tbody tr', (rows) => rows.map((x) => x.innerText));
  r.ok(picks.length === 1 && /PH-C017/.test(picks[0]), 'Cascading Area > Site > Type picker narrows to the one gas activity');
  await d.shot('27-activity-picker', { fullPage: false });
  await d.clickText('.modal table.table tbody tr', /PH-C017/);
  await wait(500);
  await d.setVal('[aria-label="Provider"]', 'Demo Gas Engineer Ltd (fictional)');
  await d.clickText('label', /^Upload new file$/);
  const cert2 = path.join(tmpDir, 'gas-record-unverified-demo.pdf');
  fs.writeFileSync(cert2, `%PDF-1.4\n% fictional unverified record ${Date.now()}\n%%EOF\n`);
  await (await page.$('[aria-label="Certificate file"]')).uploadFile(cert2);
  await d.clickText('button', /^Save inspection \/ check$/);
  await wait(800);
  r.ok(/not verified/.test(await d.within('.card table.table tbody')), 'Check saved with an unverified certificate');
  await recalc();
  row = await rowFor('PH-C017');
  r.ok(/Unknown \/ missing/.test(row) && !/Up to date/.test(row), 'Unverified certificate does not make the activity green');
  await d.go('#/inspections');
  await d.clickText('button.tab', /^Compliance Inspections \/ Checks/);
  t = await d.within('main');
  r.ok(/PH-C017 GAS/.test(t) && /PH-C012 GAS/.test(t), 'Compliance checks register lists the new checks');
  await d.shot('28-checks-register', { fullPage: false });
  await d.clickText('button.tab', /^Routine Property Inspections/);
  await d.clickText('button', /^\+ Start inspection$/);
  await d.clickText('.modal button.choice', /^Routine Property Inspection/);
  r.ok(/Start routine inspection/.test(await d.within('.modal')), 'Routine 30-point inspection still starts from the chooser');
}
