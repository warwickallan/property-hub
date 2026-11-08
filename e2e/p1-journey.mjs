// P1 journey, UI only:
// Site inspection -> record Issue -> Critical remedial action linked to an Activity -> Recalculate -> red
// -> close action with closure details -> Recalculate -> original outcome. Plus CSV exports, print sheet, mobile.
import { wait } from './lib.mjs';

const statusOf = async (d, ref) => {
  await d.go('#/activities');
  await d.setVal('input[type=search]', ref);
  const row = await d.within('table.table tbody');
  await d.setVal('input[type=search]', '');
  return row;
};

export default async function p1(d, r, { awaitDownload }) {
  const { page } = d;

  // Baseline: a calculated, in-date site-level activity whose site has no inspection yet.
  await d.go('#/');
  await d.clickText('button', /^Recalculate Compliance$/);
  await wait(1000);
  const acts = await d.api('/api/activities');
  const target = acts.find((a) => a.status === 'green' && a.location_level === 'site' && a.type_code === 'FRA' && !['PH-S001', 'PH-S002'].includes(a.site_code));
  r.ok(!!target, `Baseline activity ${target?.ref} at ${target?.site_code} is green before the journey`);

  // 1. Start a Site inspection from the Site page
  await d.go(`#/sites/${target.site_id}`);
  await d.clickText('button', /^Start inspection$/);
  await d.selectByText('[aria-label="Inspector"]', /Team Leader North/);
  await d.clickText('.modal button', /^Start inspection$/);
  await wait(700);
  const runId = Number((page.url().match(/inspections\/(\d+)/) || [])[1]);
  let t = await d.text();
  r.ok(runId > 0 && /Draft/.test(t) && /0\/30/.test(t), `Inspection started as Draft with 0/30 answered (#${runId})`);
  const qCount = await page.$$eval('.question', (q) => q.length);
  r.ok(qCount === 30, `All 30 questions shown (${qCount})`);
  r.ok(['Fire Safety', 'Security', 'Gas, Electrical & Utilities', 'Health & Wellbeing Risks', 'General Property Safety'].every((g) => t.includes(g)), 'All five categories shown');
  r.ok(t.includes('Smoke alarms – present, working (test them)'), 'Original question wording preserved');
  await d.shot('10-inspection-new', { fullPage: false });

  // 2. Record Pass + Issue with notes; save draft; resume
  await d.clickText('#q-CHK-001 .seg-btn', /^Pass$/);
  await d.clickText('#q-CHK-002 .seg-btn', /^Issue$/);
  await d.setVal('[aria-label="CHK-002 notes"]', 'CO alarm missing beside boiler (demo)');
  r.ok(/Unsaved changes/.test(await d.text()), 'Unsaved changes indicator after answering');
  await d.clickText('button', /^Save draft$/);
  r.ok(/Draft saved/.test(await d.text()), 'Draft saved');
  await d.go(`#/inspections/${runId}`);
  const resumed = await page.evaluate(() => ({
    pass: document.querySelector('#q-CHK-001 [aria-checked="true"]')?.textContent,
    issue: document.querySelector('#q-CHK-002 [aria-checked="true"]')?.textContent,
    notes: document.querySelector('[aria-label="CHK-002 notes"]')?.value,
  }));
  r.ok(resumed.pass === 'Pass' && resumed.issue === 'Issue' && /CO alarm missing/.test(resumed.notes), 'Draft resumes with saved answers and notes');
  r.ok(/2\/30/.test(await d.text()) && /28 outstanding/.test(await d.text()), 'Progress shows 2/30 and 28 outstanding');

  // 3. Issue -> Critical remedial action linked to the Activity
  await d.clickText('#q-CHK-002 button', /Create remedial action/);
  r.ok(/Remedial action for CHK-002/.test(await d.within('.modal')), 'Create remedial action offered for the Issue');
  await d.setVal('[aria-label="Action title"]', 'Fit CO alarm beside boiler (demo)');
  await d.selectByText('[aria-label="Action priority"]', /^Critical$/);
  await d.selectByText('[aria-label="Action activity"]', new RegExp(target.ref));
  await d.setVal('[aria-label="Action due"]', '2026-12-01');
  r.ok(/red at the next Recalculate/.test(await d.within('.modal')), 'Critical warning explains effect at next Recalculate');
  await d.shot('11-critical-action-modal', { fullPage: false });
  await d.clickText('.modal button', /^Create action$/);
  await wait(600);
  const chip = await page.$eval('#q-CHK-002 .action-chip', (a) => ({ text: a.textContent, href: a.getAttribute('href') })).catch(() => null);
  r.ok(!!chip && /Critical/.test(chip.text) && /Open/.test(chip.text), `Action ${chip?.text} linked under CHK-002`);
  const actionId = Number(chip.href.split('/').pop());

  // 4. Completion blocked until every question is answered
  await d.clickText('button', /^Complete inspection$/);
  r.ok(/28 question\(s\) still unanswered/.test(await d.text()), 'Completion refused with unanswered questions listed');
  await page.evaluate(() => {
    for (const q of document.querySelectorAll('.question')) {
      if (!q.querySelector('[aria-checked="true"]')) [...q.querySelectorAll('.seg-btn')].find((b) => b.textContent === (q.id === 'q-CHK-010' ? 'Not checked' : 'Pass')).click();
    }
  });
  await wait(400);
  r.ok(/30\/30/.test(await d.text()), 'All 30 answered (30/30)');
  await d.clickText('button', /^Complete inspection$/);
  await wait(600);
  t = await d.text();
  r.ok(/Completed/.test(t) && /Inspection completed/.test(t) && /Reopen for correction/.test(t), 'Inspection completed and locked');
  await d.shot('12-inspection-completed');

  // 5. Status unchanged until manual Recalculate; then red
  r.ok(/Changes pending recalculation/.test(await d.text()), 'Creating the Critical action flagged changes pending');
  r.ok(/Up to date/.test(await statusOf(d, target.ref)), `${target.ref} still green before Recalculate`);
  await d.clickText('button', /^Recalculate Compliance$/);
  await wait(1000);
  let row = await statusOf(d, target.ref);
  r.ok(/Overdue \/ at risk/.test(row), `${target.ref} red after Recalculate`);
  await d.go(`#/activities/${target.id}`);
  r.ok(/Critical open action/.test(await d.text()), 'Activity reason cites the Critical open action');
  await d.shot('13-activity-red', { fullPage: false });

  // 6. Action lifecycle: Open -> In progress -> Done with closure details
  await d.go(`#/actions/${actionId}`);
  t = await d.text();
  r.ok(t.includes(`${target.ref}`) && /CHK-002/.test(t) && /Carbon monoxide alarms/.test(t), 'Action shows source inspection question and linked activity');
  await d.clickText('button', /^Start \(In progress\)$/);
  r.ok(/In progress/.test(await d.within('.status-strip')), 'Action moved to In progress');
  await d.clickText('button', /^Close action/);
  await d.clickText('.modal button', /^Mark Done$/);
  r.ok(/Closure details are required/.test(await d.within('.modal')), 'Closing without closure details is refused');
  await d.setVal('[aria-label="Closure details"]', 'CO alarm fitted and tested by maintenance (demo)');
  await d.clickText('.modal button', /^Mark Done$/);
  await wait(500);
  t = await d.text();
  r.ok(/Done/.test(await d.within('.status-strip')) && /CO alarm fitted and tested/.test(t), 'Action Done with closure details shown');
  r.ok(/Changes pending recalculation/.test(t), 'Closing the action flagged changes pending');
  await d.shot('14-action-closed', { fullPage: false });

  // 7. Still red until Recalculate, then back to the original outcome
  r.ok(/Overdue \/ at risk/.test(await statusOf(d, target.ref)), `${target.ref} still red before Recalculate`);
  await d.clickText('button', /^Recalculate Compliance$/);
  await wait(1000);
  r.ok(/Up to date/.test(await statusOf(d, target.ref)), `${target.ref} green again after Recalculate`);

  // 8. Actions register filters + CSV export of the filtered list
  await d.go('#/actions');
  await d.selectByText('[aria-label="Status"]', /^Done$/);
  await d.selectByText('[aria-label="Priority"]', /^Critical$/);
  t = await d.within('table.table tbody');
  r.ok(t.includes('Fit CO alarm beside boiler'), 'Actions register filters by status and priority');
  await d.shot('15-actions-register', { fullPage: false });
  await d.clickText('button', /^Export CSV/);
  const actionsCsv = await awaitDownload('actions.csv');
  r.ok(/^﻿?Ref,Title,Description,Priority,Status/.test(actionsCsv) && actionsCsv.includes('CO alarm fitted and tested') && actionsCsv.trim().split('\r\n').length === 2, 'Actions CSV contains exactly the filtered row with closure details');
  await d.selectByText('[aria-label="Status"]', /^Open \+ in progress$/);
  await d.selectByText('[aria-label="Priority"]', /^All priorities$/);

  // 9. Activities register CSV honours filters
  await d.go('#/activities');
  await d.selectByText('[aria-label="Type"]', /^FRA/);
  await d.selectByText('[aria-label="Area"]', /PH-A001/);
  const shown = await page.$$eval('table.table tbody tr', (rows) => rows.length);
  await d.clickText('button', /^Export CSV/);
  const actsCsv = await awaitDownload('compliance-activities.csv');
  const lines = actsCsv.trim().split('\r\n');
  r.ok(lines.length === shown + 1 && lines.slice(1).every((l) => /,FRA,/.test(l)), `Activities CSV has the ${shown} filtered FRA rows`);
  await d.setVal('[aria-label="Type"]', '');
  await d.setVal('[aria-label="Area"]', '');

  // 10. Inspection results CSV
  await d.go(`#/inspections/${runId}`);
  await d.clickText('button', /^Export results CSV$/);
  const inspCsv = await awaitDownload(`${(await d.api(`/api/inspections/${runId}`)).ref}-results.csv`);
  const il = inspCsv.trim().split('\r\n');
  r.ok(il.length === 31 && il.some((l) => l.includes('CHK-002') && l.includes('Issue')), 'Inspection results CSV has 30 answers including the Issue');

  // 11. History + printable front sheet
  await d.go('#/inspections');
  t = await d.text();
  r.ok(/PH-I001/.test(t) && /PH-I002/.test(t) && /30\/30/.test(t), 'Inspection history lists seeded and new inspections');
  await d.shot('16-inspections-register', { fullPage: false });
  await d.go(`#/sites/${target.site_id}/print`);
  t = await d.text();
  r.ok(/Site compliance front sheet/i.test(t) && t.includes(target.ref) && /Recent routine inspections/.test(t) && !/PROPERTY HUB\s*Local demo/.test(t), 'Printable front sheet renders without app chrome');
  await page.emulateMediaType('print');
  r.ok(await page.$eval('.sheet-tools', (e) => getComputedStyle(e).display === 'none'), 'Print buttons hidden in print media');
  await d.shot('17-site-front-sheet-print');
  await page.emulateMediaType('screen');

  // 12. Mobile: the inspection form and dashboard fit a phone screen
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await d.go(`#/inspections/${runId}`);
  r.ok(await d.noHorizontalScroll(), 'Inspection form has no horizontal page scroll at 390px');
  await d.shot('18-mobile-inspection', { fullPage: false });
  await d.go('#/actions');
  await d.clickText('button', /^\+ New action$/);
  r.ok(await d.noHorizontalScroll(), 'New action form fits at 390px');
  await d.shot('19-mobile-action-form', { fullPage: false });
  await page.keyboard.press('Escape');
  await d.go('#/');
  r.ok(await d.noHorizontalScroll(), 'Dashboard has no horizontal page scroll at 390px (tables scroll inside their card)');
}
