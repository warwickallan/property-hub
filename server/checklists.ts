// Admin › Checklists: editable checklist templates per Compliance Type.
// Any change to a template's questions bumps its version; visits keep the snapshot they started with,
// so historical inspections never change. Templates and questions are archived, never hard-deleted.
import type { Express } from 'express';
import { bad, bool01, h, HttpError, idParam, notFound, optStr, reqInt, reqStr } from './http.js';
import type { Ctx } from './visits.js';

type Row = Record<string, any>;

const TEMPLATE_SELECT = `
  SELECT c.*, t.code AS type_code, t.name AS type_name, t.evidence_required,
         (SELECT COUNT(*) FROM checklist_items i WHERE i.template_id = c.id AND i.active = 1) AS item_count,
         (SELECT COUNT(*) FROM checklist_items i WHERE i.template_id = c.id AND i.active = 1 AND i.mandatory = 1) AS mandatory_count,
         (SELECT COUNT(*) FROM compliance_activities a WHERE a.checklist_template_id = c.id AND a.archived_at IS NULL) AS activity_count,
         (SELECT COUNT(*) FROM visits v WHERE v.checklist_template_id = c.id) AS visit_count
  FROM checklist_templates c JOIN compliance_types t ON t.id = c.compliance_type_id`;

export function registerChecklists(app: Express, ctx: Ctx) {
  const { db, ts } = ctx;
  const get = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const one = (id: number) => {
    const c = get(`${TEMPLATE_SELECT} WHERE c.id = ?`, id);
    if (!c) throw notFound('Checklist');
    return { ...c, items: db.prepare('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY active DESC, sort_order, id').all(id) as Row[] } as Row;
  };
  const bump = (id: number) => db.prepare('UPDATE checklist_templates SET version = version + 1, updated_at = ? WHERE id = ?').run(ts(), id);
  const mustType = (id: number) => {
    if (!get('SELECT id FROM compliance_types WHERE id = ?', id)) throw notFound('Compliance type');
    return id;
  };
  const nextItemCode = (templateId: number) => {
    const t = get('SELECT code FROM checklist_templates WHERE id = ?', templateId)!;
    const n = (get('SELECT COUNT(*) AS n FROM checklist_items WHERE template_id = ?', templateId)!.n as number) + 1;
    let code = `${t.code}-Q${String(n).padStart(2, '0')}`;
    for (let k = n + 1; get('SELECT id FROM checklist_items WHERE template_id = ? AND code = ?', templateId, code); k++) code = `${t.code}-Q${String(k).padStart(2, '0')}`;
    return code;
  };

  app.get('/api/checklists', h((_req, res) => res.json(db.prepare(`${TEMPLATE_SELECT} ORDER BY c.active DESC, t.code, c.name`).all())));
  app.get('/api/checklists/:id', h((req, res) => res.json(one(idParam(req)))));

  app.post('/api/checklists', h((req, res) => {
    const b = req.body ?? {};
    const code = (optStr(b.code) || ctx.nextCode('checklist_templates', 'code', 'CL-')).toUpperCase();
    if (get('SELECT id FROM checklist_templates WHERE code = ?', code)) throw bad(`Checklist code ${code} already exists`);
    const id = Number(db.prepare(`INSERT INTO checklist_templates (code, name, compliance_type_id, description, version, active, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, 'admin', ?, ?)`).run(code, reqStr(b.name, 'Checklist name'), mustType(reqInt(b.compliance_type_id, 'Compliance type')),
      optStr(b.description), ts(), ts()).lastInsertRowid);
    res.status(201).json(one(id));
  }));

  app.put('/api/checklists/:id', h((req, res) => {
    const id = idParam(req);
    const cur = one(id);
    const b = req.body ?? {};
    const typeId = b.compliance_type_id !== undefined ? mustType(reqInt(b.compliance_type_id, 'Compliance type')) : cur.compliance_type_id;
    if (typeId !== cur.compliance_type_id && get('SELECT id FROM compliance_activities WHERE checklist_template_id = ? AND type_id <> ?', id, typeId)) {
      throw new HttpError(409, 'Activities of another type use this checklist; duplicate it instead of changing its type');
    }
    db.prepare('UPDATE checklist_templates SET name = ?, compliance_type_id = ?, description = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(b.name !== undefined ? reqStr(b.name, 'Checklist name') : cur.name, typeId, b.description !== undefined ? optStr(b.description) : cur.description,
        bool01(b.active, cur.active), ts(), id);
    res.json(one(id));
  }));

  app.post('/api/checklists/:id/duplicate', h((req, res) => {
    const src = one(idParam(req));
    const code = ctx.nextCode('checklist_templates', 'code', 'CL-');
    const newId = db.transaction(() => {
      const nid = Number(db.prepare(`INSERT INTO checklist_templates (code, name, compliance_type_id, description, version, active, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`).run(code, optStr(req.body?.name) || `${src.name} (copy)`, src.compliance_type_id, src.description,
        `copy of ${src.code} v${src.version}`, ts(), ts()).lastInsertRowid);
      const ins = db.prepare(`INSERT INTO checklist_items (template_id, code, section, question, sort_order, mandatory, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
      for (const i of src.items.filter((x: Row) => x.active)) ins.run(nid, i.code, i.section, i.question, i.sort_order, i.mandatory, ts(), ts());
      return nid;
    })();
    res.status(201).json(one(newId));
  }));

  app.post('/api/checklists/:id/items', h((req, res) => {
    const id = idParam(req);
    one(id);
    const b = req.body ?? {};
    const code = optStr(b.code) || nextItemCode(id);
    if (get('SELECT id FROM checklist_items WHERE template_id = ? AND code = ?', id, code)) throw bad(`Question code ${code} already exists on this checklist`);
    const order = (get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM checklist_items WHERE template_id = ?', id)!.m as number) + 1;
    db.transaction(() => {
      db.prepare(`INSERT INTO checklist_items (template_id, code, section, question, sort_order, mandatory, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, code, optStr(b.section), reqStr(b.question, 'Question text'), order, bool01(b.mandatory, 1), ts(), ts());
      bump(id);
    })();
    res.status(201).json(one(id));
  }));

  app.put('/api/checklist-items/:id', h((req, res) => {
    const id = idParam(req);
    const cur = get('SELECT * FROM checklist_items WHERE id = ?', id);
    if (!cur) throw notFound('Checklist question');
    const b = req.body ?? {};
    db.transaction(() => {
      db.prepare('UPDATE checklist_items SET question = ?, section = ?, mandatory = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(b.question !== undefined ? reqStr(b.question, 'Question text') : cur.question, b.section !== undefined ? optStr(b.section) : cur.section,
          bool01(b.mandatory, cur.mandatory), bool01(b.active, cur.active), ts(), id);
      bump(cur.template_id);
    })();
    res.json(one(cur.template_id));
  }));

  app.post('/api/checklists/:id/reorder', h((req, res) => {
    const id = idParam(req);
    const cur = one(id);
    const ids: number[] = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map((x: unknown) => reqInt(x, 'item id')) : [];
    const mine = new Set(cur.items.map((i: Row) => i.id));
    if (!ids.length || ids.some((x) => !mine.has(x))) throw bad('item_ids must list questions of this checklist');
    db.transaction(() => {
      const upd = db.prepare('UPDATE checklist_items SET sort_order = ?, updated_at = ? WHERE id = ?');
      ids.forEach((x, i) => upd.run(i + 1, ts(), x));
      bump(id);
    })();
    res.json(one(id));
  }));
}
