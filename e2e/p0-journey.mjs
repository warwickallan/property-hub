// P0 acceptance-critical route, UI only:
// Admin > Area/Site/Room > Equipment > New Activity > link equipment > upload once, link in two more contexts
// > Dashboard pending > Recalculate > RAG > Reminder preview / draft export.
import fs from 'node:fs';
import path from 'node:path';
import { wait } from './lib.mjs';

export default async function p0(d, r, { tmpDir }) {
  const { page } = d;
  const stamp = Date.now().toString().slice(-5);
  const SITE = `Demo House W${stamp}`;
  const pdf = path.join(tmpDir, 'sample-certificate.pdf');
  fs.writeFileSync(pdf, `%PDF-1.4\n% fictional sample certificate ${stamp}\n%%EOF\n`);

  await d.go('#/');
  let t = await d.text();
  r.ok(/Dashboard/.test(t) && /Not yet calculated/i.test(t), 'Dashboard is home; shows Not yet calculated before first run');
  await d.shot('00-dashboard-initial');

  await d.go('#/admin/core');
  await d.clickText('button', /^\+ Add area$/);
  await d.setVal('[aria-label="area name"]', `North ${stamp}`);
  await d.clickText('.modal button', /^Save$/);
  await d.clickText('button', /^\+ Add site$/);
  await d.setVal('[aria-label="site name"]', SITE);
  await d.clickText('.modal button', /^Save$/);
  for (const room of ['Kitchen', 'Office']) {
    await d.clickText('button', /^\+ Add room$/);
    await d.setVal('[aria-label="room name"]', room);
    await d.clickText('.modal button', /^Save$/);
  }
  t = await d.text();
  r.ok(t.includes(`North ${stamp}`) && t.includes(SITE) && /Kitchen/.test(t) && /Office/.test(t), 'Core Data: Area, Site under Area, two Rooms under Site');
  await d.shot('01-core-data');

  const core = await d.api('/api/core');
  const site = core.sites.find((s) => s.name === SITE);
  const kitchen = core.rooms.find((x) => x.site_id === site.id && x.name === 'Kitchen');
  const office = core.rooms.find((x) => x.site_id === site.id && x.name === 'Office');

  await d.go(`#/rooms/${kitchen.id}`);
  await d.clickText('button', /Add equipment to this room/);
  await d.setVal('[aria-label="Description"]', 'Kettle 001');
  await d.clickText('.modal button', /^Save equipment$/);
  r.ok(/Kettle 001/.test(await d.text()), 'Equipment Kettle 001 created in Kitchen room');

  await d.go('#/activities/new');
  await d.selectByText('[aria-label="Compliance type"]', /^PAT/);
  await d.selectByText('[aria-label="Location area"]', new RegExp(`North ${stamp}`));
  await d.selectByText('[aria-label="Location site"]', new RegExp(SITE));
  await wait(500);
  await d.clickText('label.pick-row', /Kettle 001/);
  await d.setVal('input[placeholder="e.g. PAT 2027"]', 'PAT 2027');
  // No last inspection yet, so the first due date is entered as an explicit (reasoned) override.
  await page.$eval('[aria-label="Override next due"]', (c) => c.click());
  await wait(250);
  await d.setVal('[aria-label="Next due"]', '2027-06-01');
  await d.setVal('[aria-label="Override reason"]', 'First PAT test booked (demo)');
  await d.selectByText('[aria-label="Responsible person"]', /Team Leader North/);
  await (await page.$('input[type=file]')).uploadFile(pdf);
  await d.shot('02-new-activity-form');
  await d.clickText('button', /^Save activity$/);
  await wait(800);
  const actId = Number((page.url().match(/activities\/(\d+)/) || [])[1]);
  r.ok(actId > 0 && /PAT 2027/.test(await d.text()), `Activity saved and detail opened (#${actId})`);
  await d.clickText('button.tab', /Linked Equipment/);
  t = await d.text();
  r.ok(/Kettle 001/.test(t) && /In scope/.test(t), 'Activity shows linked Kettle 001 in scope');
  await d.clickText('button.tab', /Documents/);
  t = await d.text();
  r.ok(/sample-certificate/.test(t) && /Not verified/.test(t), 'Uploaded document linked to activity, not verified on upload');

  await d.go('#/documents');
  await d.setVal('input[type=search]', 'sample-certificate');
  await d.clickText('tbody tr', /sample-certificate/);
  await d.selectByText('[aria-label="Link target"]', /\[equipment\].*Kettle 001/);
  await d.clickText('.modal button', /^Link$/);
  await d.selectByText('[aria-label="Link target"]', new RegExp(`\\[site\\].*${SITE}`));
  await d.clickText('.modal button', /^Link$/);
  r.ok(/Linked records \(3\)/.test(await d.within('.modal')), 'One document linked in three contexts (activity, equipment, site)');
  await page.$eval('.modal input[type=checkbox]', (c) => c.click());
  await d.clickText('.modal button', /^Save details$/);
  await d.shot('03-document-three-links');
  const docs = await d.api('/api/documents');
  r.ok(docs.filter((x) => /sample-certificate/.test(x.original_filename)).length === 1, 'Only one stored document for the sample file');
  await page.keyboard.press('Escape');
  const siteDocs = await d.api(`/api/documents?entity_kind=site&entity_id=${site.id}`);
  r.ok(siteDocs.some((x) => /sample-certificate/.test(x.original_filename)), 'Site record shows the shared document');

  await d.go('#/');
  await d.clickText('button.tab', /^All/);
  r.ok(/Changes pending recalculation/.test(await d.text()), 'Header shows Changes pending recalculation after saves');
  await d.setVal('input[type=search]', 'PAT 2027');
  r.ok(/Not yet calculated/.test(await d.within('table.table tbody')), 'New activity has no status before Recalculate');

  await d.clickText('button', /^Recalculate Compliance$/);
  await wait(1200);
  t = await d.text();
  r.ok(!/Changes pending recalculation/.test(t) && /Last calculated/.test(t), 'Recalculate clears pending and stamps last-calculated time');
  r.ok(/Up to date/.test(await d.within('table.table tbody')), 'PAT 2027 is green (verified evidence, due 01/06/2027)');
  await d.setVal('input[type=search]', '');
  t = await d.text();
  r.ok(/Overdue \/ at risk/.test(t) && /Due soon/.test(t) && /Unknown \/ missing/.test(t), 'Dashboard shows red/amber/grey statuses after Recalculate');
  await d.shot('04-dashboard-rag', { fullPage: false });
  await d.clickText('button.tab', /By Location/);
  r.ok(new RegExp(SITE).test(await d.text()), 'By Location view lists the new site');
  await d.clickText('button.tab', /^All/);

  await d.go('#/reminders');
  t = await d.text();
  r.ok(/Reminder candidates \(\d+\)/.test(t) && /Demo mode/.test(t), 'Reminder candidates generated by Recalculate, demo mode banner shown');
  await page.$eval('tbody input[type=checkbox]', (c) => c.click());
  await wait(400);
  await d.clickText('button', /Preview \/ edit/);
  r.ok(/Draft reminder/.test(await d.within('.modal')), 'Reminder draft preview opens and is editable');
  await d.shot('05-reminder-preview', { fullPage: false });
  await d.clickText('.modal button', /^Close$/);
  await d.clickText('button', /^Export 1 draft/);
  await wait(600);
  r.ok(/exported/i.test(await d.text()), 'Selected reminder exported as .eml draft (no send)');

  await d.go(`#/sites/${site.id}`);
  t = await d.text();
  r.ok(/front sheet/i.test(t) && /PAT 2027/.test(t) && /sample-certificate/.test(t), 'Site front sheet shows the activity and its document');

  const cand = await d.api(`/api/equipment?level=room&location_id=${office.id}`);
  r.ok(!cand.some((e) => e.description === 'Kettle 001'), 'Office-scoped picker does not offer Kitchen equipment');
}
