// V2 structure, UI only: navigation split, Admin › Checklists (create/edit/reorder/archive/duplicate),
// paperwork setting on Compliance Types, checklist chosen on an Activity, and frozen checklist history.
import { wait } from './lib.mjs';

export default async function v2(d, r) {
  const { page } = d;
  await d.go('#/');
  const nav = await page.$$eval('.sidebar > ul a', (as) => as.map((a) => a.textContent.trim()));
  r.ok(JSON.stringify(nav.slice(0, 6)) === JSON.stringify(['Dashboard', 'Inspections / Visits', 'Remedials', 'Equipment', 'Documents', 'Reminders']), `Main navigation: ${nav.slice(0, 6).join(', ')}`);
  const admin = await page.$$eval('.admin-nav a', (as) => as.map((a) => a.textContent.trim()));
  r.ok(JSON.stringify(admin) === JSON.stringify(['People / Users', 'Property Details', 'Compliance Types', 'Checklists', 'Compliance Activities', 'Settings']), `Admin navigation: ${admin.join(', ')}`);

  // Checklists list
  await d.go('#/admin/checklists');
  let t = await d.within('table.table tbody');
  r.ok(/RPI-FIRE[\s\S]*8/.test(t) && /RPI-SEC/.test(t) && /RPI-UTIL/.test(t) && /RPI-HWB/.test(t) && /RPI-GEN/.test(t), 'Five routine checklists listed');
  const lists = await d.api('/api/checklists');
  const counts = Object.fromEntries(lists.filter((c) => c.type_code === 'RPI').map((c) => [c.code, c.item_count]));
  r.ok(counts['RPI-FIRE'] === 8 && counts['RPI-SEC'] === 4 && counts['RPI-UTIL'] === 5 && counts['RPI-HWB'] === 6 && counts['RPI-GEN'] === 7, 'Question counts 8/4/5/6/7');
  await d.shot('30-checklists', { fullPage: false });

  // Create a checklist for Gas Safety
  await d.clickText('button', /^\+ New checklist$/);
  await d.setVal('.modal [aria-label="Checklist name"]', 'Gas safety visit (demo)');
  await d.selectByText('[aria-label="New checklist type"]', /^GAS/);
  await d.clickText('.modal button', /^Create checklist$/);
  await wait(600);
  const clId = Number((page.url().match(/checklists\/(\d+)/) || [])[1]);
  for (const q of ['Appliances tested (demo)', 'CO alarm present (demo)', 'Flue visually sound (demo)']) {
    await d.setVal('[aria-label="New question"]', q);
    await d.clickText('button', /^Add question$/);
  }
  t = await d.text();
  r.ok(/Questions \(3 active\)/.test(t) && /v4/.test(t), 'Three questions added; version bumped per change');
  await d.clickText('button', /^↓$/); // move first question down
  let qs = await page.$$eval('table.compact tbody tr td:nth-child(4)', (tds) => tds.map((x) => x.textContent));
  r.ok(qs[0] === 'CO alarm present (demo)' && qs[1] === 'Appliances tested (demo)', 'Reordered questions');
  await page.evaluate(() => [...[...document.querySelectorAll('table.compact tbody tr')][2].querySelectorAll('button')].find((b) => b.textContent === 'Archive').click());
  await wait(500);
  r.ok(/Questions \(2 active\)/.test(await d.text()), 'A question archived (not deleted)');
  await d.shot('31-checklist-editor', { fullPage: false });
  await d.clickText('button', /^Duplicate$/);
  await wait(600);
  r.ok(/\(copy\)/.test(await d.text()), 'Checklist duplicated');

  // Compliance Types: paperwork setting
  await d.go('#/admin/types');
  t = await d.within('table.table tbody');
  r.ok(/GAS[\s\S]*Yes: blocks closure until verified/.test(t) && /RPI[\s\S]*No/.test(t), 'Types show Evidence / Certificate required (GAS yes, routine no)');

  // Assign the new checklist to a Gas activity
  const gas = (await d.api('/api/activities')).find((a) => a.ref === 'PH-C022');
  await d.go(`#/activities/${gas.id}/edit`);
  await d.selectByText('[aria-label="Activity checklist"]', /^Gas safety visit \(demo\)/);
  await d.clickText('button', /^Save activity$/);
  await wait(600);
  r.ok(/Gas safety visit \(demo\)/.test(await d.text()), 'Activity uses the new Gas checklist');

  // Frozen history: edit the routine Fire checklist and check an existing closed visit is unchanged
  const closed = (await d.api('/api/visits')).find((v) => v.status === 'closed' && v.checklist_name === 'Routine — Fire Safety');
  const fireTpl = lists.find((c) => c.code === 'RPI-FIRE');
  await d.go(`#/admin/checklists/${fireTpl.id}`);
  await d.clickText('table.compact tbody tr:first-child button', /^Edit$/);
  await d.setVal('[aria-label="Edit question"]', 'Smoke alarms tested and logged (edited demo wording)');
  await d.clickText('.modal button', /^Save question$/);
  await wait(500);
  await d.go(`#/visits/${closed.id}`);
  t = await d.text();
  r.ok(t.includes('Smoke alarms – present, working (test them)') && !t.includes('edited demo wording'), `Closed visit ${closed.ref} keeps the original wording and version`);
  await d.shot('32-frozen-history', { fullPage: false });

  // Admin › Compliance Activities register is reachable and shows checklists
  await d.go('#/admin/activities');
  t = await d.text();
  r.ok(/Compliance Activities/.test(t) && /Checklist/.test(t) && /Routine — Fire Safety/.test(t), 'Compliance Activities register lives under Admin and shows checklists');
}
