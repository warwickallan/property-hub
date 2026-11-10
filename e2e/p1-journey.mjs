// P1 on the V2 workflow, UI only:
// Dashboard -> due routine activity -> Start visit -> 8-question checklist (not 30) -> Issue -> Critical remedial
// -> Complete with Remedials -> Close blocked -> Recalculate red -> remedial Done -> visit auto-closes (no paperwork)
// -> Recalculate -> compliant. Plus registers, CSV exports, print sheet and phone layout.
import { wait } from './lib.mjs';

export default async function p1(d, r, { awaitDownload }) {
  const { page } = d;
  const recalc = async () => { await d.clickText('button', /^Recalculate Compliance$/); await wait(1100); };
  const dashRow = async (ref) => {
    await d.go('#/');
    await d.clickText('button.tab', /^All/);
    await d.setVal('input[type=search]', ref);
    return d.within('table.table tbody');
  };

  await d.go('#/');
  await recalc();
  const acts = await d.api('/api/activities');
  const fire = acts.find((a) => a.site_code === 'PH-S004' && a.checklist_name === 'Routine — Fire Safety');
  r.ok(!!fire && !fire.open_visit_id, `Routine Fire Safety activity ${fire?.ref} at PH-S004 found with no open visit`);

  // 1. Dashboard -> Start visit
  let row = await dashRow(fire.ref);
  r.ok(/Start visit/.test(row), 'Dashboard row offers Start visit');
  await d.clickText('table.table tbody button', /^Start visit$/);
  await wait(800);
  const visitId = Number((page.url().match(/visits\/(\d+)/) || [])[1]);
  let t = await d.text();
  r.ok(visitId > 0 && /Scheduled \/ In Progress/.test(t), `Visit started and opened (#${visitId})`);
  const qCount = await page.$$eval('.question', (q) => q.length);
  r.ok(qCount === 8, `Only the activity's checklist is shown: ${qCount} Fire Safety questions, not 30`);
  r.ok(t.includes('Smoke alarms – present, working (test them)') && /Compliance Activity/.test(t) && t.includes(fire.ref), 'Original wording and the Activity → Visit chain are visible');
  await d.shot('10-visit-start', { fullPage: false });

  // 2. Answer, save, resume
  await page.evaluate(() => {
    for (const q of document.querySelectorAll('.question')) {
      const pick = q.id === 'q-CHK-002' ? 'Issue' : 'Pass';
      [...q.querySelectorAll('.seg-btn')].find((b) => b.textContent === pick).click();
    }
  });
  await wait(300);
  await d.setVal('[aria-label="CHK-002 notes"]', 'CO alarm missing beside boiler (demo)');
  r.ok(/Unsaved changes/.test(await d.text()), 'Unsaved changes indicator');
  await d.clickText('button', /^Save$/);
  await d.go(`#/visits/${visitId}`);
  const resumed = await page.evaluate(() => ({
    issue: document.querySelector('#q-CHK-002 [aria-checked="true"]')?.textContent,
    notes: document.querySelector('[aria-label="CHK-002 notes"]')?.value,
  }));
  r.ok(resumed.issue === 'Issue' && /CO alarm missing/.test(resumed.notes), 'Visit resumes with saved answers');

  // 3. Raise Critical remedial from the Issue
  await d.clickText('#q-CHK-002 button', /Raise remedial/);
  r.ok(/Raise remedial on PH-V\d+ \(CHK-002\)/.test(await d.within('.modal')), 'Raise remedial offered on the Issue');
  await d.setVal('[aria-label="Remedial title"]', 'Fit CO alarm beside boiler (demo)');
  await d.selectByText('[aria-label="Remedial priority"]', /^Critical$/);
  await d.setVal('[aria-label="Remedial due"]', '2026-12-01');
  await d.shot('11-raise-remedial', { fullPage: false });
  await d.clickText('.modal button', /^Raise remedial$/);
  await wait(700);
  const chip = await page.$eval('#q-CHK-002 .action-chip', (a) => ({ text: a.textContent, href: a.getAttribute('href') })).catch(() => null);
  r.ok(!!chip && /Critical/.test(chip.text), `Remedial ${chip?.text} shown under CHK-002`);
  const remId = Number(chip.href.split('/').pop());

  // 4. Complete with Remedials; Close blocked
  await d.clickText('button', /^Complete Inspection…$/);
  r.ok(/Complete with Remedials/.test(await d.within('.modal')) && /Proposed next due/.test(await d.within('.modal')), 'Complete modal offers outcome and proposed next due');
  await d.clickText('.modal button', /^Record Complete with Remedials$/);
  await wait(800);
  t = await d.text();
  r.ok(/Complete with Remedials/.test(t) && /Close is blocked/.test(t) && /1 remedial\(s\) not Done/.test(t), 'Status Complete with Remedials and the blocking remedial is listed');
  r.ok(await page.$eval('button.btn-lg:not([disabled]), button.btn-lg[disabled]', () => true) &&
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close Inspection')?.disabled === true), 'Close Inspection button is disabled');
  await d.shot('12-close-blocked', { fullPage: false });
  r.ok(/Changes pending recalculation/.test(t), 'Changes pending after recording work');

  // 5. Recalculate -> red (Critical)
  row = await dashRow(fire.ref);
  r.ok(!/Overdue \/ at risk/.test(row), 'Status unchanged before Recalculate');
  await recalc();
  row = await dashRow(fire.ref);
  r.ok(/Overdue \/ at risk/.test(row) && /1 open/.test(row) && /Complete with Remedials/.test(row), 'After Recalculate: red, 1 open remedial, latest visit Complete with Remedials');
  await d.shot('13-dashboard-red', { fullPage: false });

  // 6. Resolve the remedial -> visit auto-closes (no paperwork required)
  await d.go(`#/remedials/${remId}`);
  t = await d.text();
  // .chain-step is inline-flex, so innerText breaks lines between its children: normalise whitespace.
  const chainText = (await d.within('.chain').catch(() => '(no chain)')).replace(/\s+/g, ' ');
  r.ok(/Remedial PH-X\d+/.test(chainText) && /Inspection PH-V\d+/.test(chainText) && chainText.includes(fire.ref), `Remedial page shows Remedial → Inspection → Activity [${chainText.replace(/\s+/g, ' ')}]`);
  await d.clickText('button', /^Start \(In progress\)$/);
  await d.clickText('button', /^Mark Done…$/);
  await d.clickText('.modal button', /^Mark Done$/);
  r.ok(/Closure details are required/.test(await d.within('.modal')), 'Done without closure details refused');
  await d.setVal('[aria-label="Closure details"]', 'CO alarm fitted and tested (demo)');
  await d.clickText('.modal button', /^Mark Done$/);
  await wait(700);
  r.ok(/is now: Closed/.test(await d.text()), 'Resolving the final remedial closed the inspection automatically');
  await d.go(`#/visits/${visitId}`);
  t = await d.text();
  r.ok(/Closed/.test(await d.within('.chain')) && /auto closed/.test(t), 'Visit Closed with an auto-closed timeline entry');
  r.ok(/Reopen inspection/.test(t) && !/Complete Inspection/.test(t), 'Closed visit is locked (reopen only)');
  await d.shot('14-visit-closed');

  // 7. Still red until Recalculate, then compliant
  row = await dashRow(fire.ref);
  r.ok(/Overdue \/ at risk/.test(row), 'Still red before Recalculate (no silent recalculation)');
  await recalc();
  row = await dashRow(fire.ref);
  r.ok(/Up to date/.test(row) && /Closed/.test(row), 'After Recalculate: compliant, latest visit Closed');

  // 8. Registers + CSV
  await d.go('#/remedials');
  await d.selectByText('[aria-label="Status"]', /^Done$/);
  await d.selectByText('[aria-label="Priority"]', /^Critical$/);
  r.ok((await d.within('table.table tbody')).includes('Fit CO alarm beside boiler'), 'Remedials register filters by status and priority');
  await d.shot('15-remedials-register', { fullPage: false });
  await d.clickText('button', /^Export CSV/);
  const csv = await awaitDownload('remedials.csv');
  r.ok(/^﻿?Ref,Title,Description,Priority,Status/.test(csv) && csv.includes('CO alarm fitted and tested') && csv.trim().split('\r\n').length === 2, 'Remedials CSV = filtered row with closure details and visit');
  await d.selectByText('[aria-label="Status"]', /^Open \+ in progress$/);
  await d.selectByText('[aria-label="Priority"]', /^All priorities$/);

  await d.go('#/admin/activities');
  await d.selectByText('[aria-label="Type"]', /^FRA/);
  await d.selectByText('[aria-label="Area"]', /PH-A001/);
  const shown = await page.$$eval('table.table tbody tr', (rows) => rows.length);
  await d.clickText('button', /^Export CSV/);
  const actsCsv = await awaitDownload('compliance-activities.csv');
  const lines = actsCsv.trim().split('\r\n');
  r.ok(lines.length === shown + 1 && lines.slice(1).every((l) => /,FRA,/.test(l)), `Activities CSV has the ${shown} filtered FRA rows`);
  await d.setVal('[aria-label="Type"]', '');
  await d.setVal('[aria-label="Area"]', '');

  await d.go('#/visits');
  await d.selectByText('[aria-label="Visit status"]', /^Closed$/);
  t = await d.within('table.table tbody');
  r.ok(t.includes(fire.ref), 'Visits register lists the closed visit');
  await d.shot('16-visits-register', { fullPage: false });
  await d.clickText('button', /^Export results CSV/);
  const vcsv = await awaitDownload('inspection-results.csv');
  r.ok(/^﻿?Visit,Activity,Type/.test(vcsv) && vcsv.includes('CHK-002') && vcsv.includes('Issue'), 'Visit results CSV includes the Issue answer');
  await d.selectByText('[aria-label="Visit status"]', /^Not closed$/);

  // 9. Print sheet
  await d.go(`#/sites/${fire.site_id}/print`);
  t = await d.text();
  r.ok(/Site compliance front sheet/i.test(t) && t.includes(fire.ref) && /Recent inspections \/ visits/i.test(t), 'Printable front sheet lists activities and visits');
  await page.emulateMediaType('print');
  r.ok(await page.$eval('.sheet-tools', (e) => getComputedStyle(e).display === 'none'), 'Print buttons hidden in print media');
  await d.shot('17-site-front-sheet-print');
  await page.emulateMediaType('screen');

  // 10. Phone layout
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await d.go(`#/visits/${visitId}`);
  r.ok(await d.noHorizontalScroll(), 'Visit page has no horizontal page scroll at 390px');
  await d.shot('18-mobile-visit', { fullPage: false });
  await d.go('#/');
  r.ok(await d.noHorizontalScroll(), 'Dashboard has no horizontal page scroll at 390px');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}
