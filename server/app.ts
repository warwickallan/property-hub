// Express API for Property Hub (v0.3). Local-only, single operator, no auth.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from './db.js';
import { EDITABLE_SETTINGS, getSetting, isPending, markPending, parseThresholds, setSetting } from './db.js';
import { londonToday, optDate } from './dates.js';
import { ACTIVITY_LOCATION_JOINS, latestRun, recalculate } from './recalculate.js';
import { candidateEml, exportDrafts, isEmail, sendReminders, type CandidateRow } from './reminders.js';
import { bad, bool01, errorMiddleware, h, HttpError, idParam, notFound, optInt, optStr, reqInt, reqStr } from './http.js';

export interface AppOptions {
  db: DB;
  uploadsDir: string;
  outboxDir: string;
  now?: () => Date;
}

type Row = Record<string, any>;
type Level = 'area' | 'site' | 'room';
const LEVELS: Level[] = ['area', 'site', 'room'];
const LEVEL_TABLE: Record<Level, string> = { area: 'areas', site: 'sites', room: 'rooms' };

export const ENTITY_KINDS = ['area', 'site', 'room', 'equipment', 'activity', 'inspection', 'action'] as const;
type EntityKind = (typeof ENTITY_KINDS)[number];
const ENTITY_TABLE: Record<EntityKind, string> = {
  area: 'areas', site: 'sites', room: 'rooms', equipment: 'equipment', activity: 'compliance_activities', inspection: 'inspection_runs', action: 'actions',
};

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const INLINE_MIME = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;
const STORAGE_KEY_RE = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;

export function createApp(opts: AppOptions) {
  const { db, uploadsDir, outboxDir } = opts;
  const now = opts.now ?? (() => new Date());
  const ts = () => now().toISOString();
  fs.mkdirSync(uploadsDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Any successful write (other than recalculation and reminder handling) marks the snapshot stale.
  app.use('/api', (req, res, next) => {
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    const exempt = req.path.startsWith('/recalculate') || req.path.startsWith('/reminders');
    if (mutating && !exempt) {
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        if (res.statusCode < 400) markPending(db);
        return json(body);
      };
    }
    next();
  });

  const get = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const all = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Row[];
  const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p);
  const must = (sql: string, id: number, what: string) => {
    const r = get(sql, id);
    if (!r) throw notFound(what);
    return r;
  };

  /** Next PH-X### code for a table column. */
  const nextCode = (table: string, col: string, prefix: string) => {
    const rows = all(`SELECT ${col} AS c FROM ${table} WHERE ${col} LIKE ?`, `${prefix}%`);
    const max = rows.reduce((m, r) => Math.max(m, Number(String(r.c).slice(prefix.length)) || 0), 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  };

  // ---------- status / settings ----------
  app.get('/api/status', h((_req, res) => {
    const r = latestRun(db);
    res.json({
      today: londonToday(now()),
      pending: isPending(db),
      lastRun: r ? { id: r.id, createdAt: r.created_at, asOfDate: r.as_of_date, totals: JSON.parse(r.totals_json) } : null,
      operatorName: getSetting(db, 'operator_name'),
      emailMode: 'demo',
    });
  }));

  app.get('/api/settings', h((_req, res) => {
    res.json(Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, getSetting(db, k)])));
  }));
  app.put('/api/settings', h((req, res) => {
    const b = req.body ?? {};
    if (b.warning_days !== undefined) {
      const n = Number(b.warning_days);
      if (!Number.isInteger(n) || n < 0 || n > 365) throw bad('Warning days must be 0-365');
      setSetting(db, 'warning_days', String(n));
    }
    if (b.reminder_thresholds !== undefined) {
      const t = parseThresholds(String(b.reminder_thresholds));
      if (!t.length) throw bad('Reminder thresholds must be comma-separated whole numbers, e.g. 30,14,7');
      setSetting(db, 'reminder_thresholds', t.join(','));
    }
    if (b.operator_name !== undefined) setSetting(db, 'operator_name', reqStr(b.operator_name, 'Operator name'));
    res.json(Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, getSetting(db, k)])));
  }));

  // ---------- core data (areas / sites / rooms) ----------
  const listAreas = () => all(`SELECT a.*, (SELECT COUNT(*) FROM sites s WHERE s.area_id = a.id) AS site_count FROM areas a ORDER BY a.code`);
  const listSites = () => all(
    `SELECT s.*, a.code AS area_code, a.name AS area_name,
       (SELECT COUNT(*) FROM rooms r WHERE r.site_id = s.id) AS room_count
     FROM sites s JOIN areas a ON a.id = s.area_id ORDER BY s.code`);
  const listRooms = () => all(
    `SELECT r.*, s.code AS site_code, s.name AS site_name, s.area_id,
       (SELECT COUNT(*) FROM equipment e WHERE e.room_id = r.id) AS equipment_count
     FROM rooms r JOIN sites s ON s.id = r.site_id ORDER BY r.code`);

  app.get('/api/core', h((_req, res) => {
    res.json({
      areas: listAreas(),
      sites: listSites(),
      rooms: listRooms(),
      users: all('SELECT * FROM users ORDER BY active DESC, name'),
      types: all('SELECT * FROM compliance_types ORDER BY active DESC, name'),
      equipment: all(`SELECT e.id, e.asset_code, e.description, e.category, e.room_id, e.active FROM equipment e ORDER BY e.asset_code`),
    });
  }));

  // Areas
  app.post('/api/areas', h((req, res) => {
    const b = req.body ?? {};
    const code = optStr(b.code) || nextCode('areas', 'code', 'PH-A');
    const id = run('INSERT INTO areas (code, name, notes, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      code, reqStr(b.name, 'Area name'), optStr(b.notes), ts(), ts()).lastInsertRowid;
    res.status(201).json(get('SELECT * FROM areas WHERE id = ?', id));
  }));
  app.put('/api/areas/:id', h((req, res) => {
    const id = idParam(req);
    const cur = must('SELECT * FROM areas WHERE id = ?', id, 'Area');
    const b = req.body ?? {};
    run('UPDATE areas SET code = ?, name = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?',
      b.code !== undefined ? reqStr(b.code, 'Code') : cur.code, b.name !== undefined ? reqStr(b.name, 'Area name') : cur.name,
      b.notes !== undefined ? optStr(b.notes) : cur.notes, bool01(b.active, cur.active), ts(), id);
    res.json(get('SELECT * FROM areas WHERE id = ?', id));
  }));
  app.delete('/api/areas/:id', h((req, res) => {
    const id = idParam(req);
    must('SELECT id FROM areas WHERE id = ?', id, 'Area');
    const n = get('SELECT COUNT(*) AS n FROM sites WHERE area_id = ?', id)!.n;
    if (n) throw new HttpError(409, `Cannot delete: this Area has ${n} Site(s). Archive it instead.`);
    run('DELETE FROM areas WHERE id = ?', id);
    res.json({ ok: true });
  }));

  // Sites
  app.post('/api/sites', h((req, res) => {
    const b = req.body ?? {};
    const areaId = reqInt(b.area_id, 'Area');
    must('SELECT id FROM areas WHERE id = ?', areaId, 'Area');
    const code = optStr(b.code) || nextCode('sites', 'code', 'PH-S');
    const id = run('INSERT INTO sites (area_id, code, name, notes, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      areaId, code, reqStr(b.name, 'Site name'), optStr(b.notes), ts(), ts()).lastInsertRowid;
    res.status(201).json(get('SELECT * FROM sites WHERE id = ?', id));
  }));
  app.put('/api/sites/:id', h((req, res) => {
    const id = idParam(req);
    const cur = must('SELECT * FROM sites WHERE id = ?', id, 'Site');
    const b = req.body ?? {};
    const areaId = b.area_id !== undefined ? reqInt(b.area_id, 'Area') : cur.area_id;
    must('SELECT id FROM areas WHERE id = ?', areaId, 'Area');
    run('UPDATE sites SET area_id = ?, code = ?, name = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?',
      areaId, b.code !== undefined ? reqStr(b.code, 'Code') : cur.code, b.name !== undefined ? reqStr(b.name, 'Site name') : cur.name,
      b.notes !== undefined ? optStr(b.notes) : cur.notes, bool01(b.active, cur.active), ts(), id);
    res.json(get('SELECT * FROM sites WHERE id = ?', id));
  }));
  app.delete('/api/sites/:id', h((req, res) => {
    const id = idParam(req);
    must('SELECT id FROM sites WHERE id = ?', id, 'Site');
    const n = get('SELECT COUNT(*) AS n FROM rooms WHERE site_id = ?', id)!.n;
    if (n) throw new HttpError(409, `Cannot delete: this Site has ${n} Room(s). Archive it instead.`);
    run('DELETE FROM sites WHERE id = ?', id);
    res.json({ ok: true });
  }));

  // Rooms
  app.post('/api/rooms', h((req, res) => {
    const b = req.body ?? {};
    const siteId = reqInt(b.site_id, 'Site');
    must('SELECT id FROM sites WHERE id = ?', siteId, 'Site');
    const code = optStr(b.code) || nextCode('rooms', 'code', 'PH-R');
    const id = run('INSERT INTO rooms (site_id, code, name, notes, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      siteId, code, reqStr(b.name, 'Room name'), optStr(b.notes), ts(), ts()).lastInsertRowid;
    res.status(201).json(get('SELECT * FROM rooms WHERE id = ?', id));
  }));
  app.put('/api/rooms/:id', h((req, res) => {
    const id = idParam(req);
    const cur = must('SELECT * FROM rooms WHERE id = ?', id, 'Room');
    const b = req.body ?? {};
    const siteId = b.site_id !== undefined ? reqInt(b.site_id, 'Site') : cur.site_id;
    must('SELECT id FROM sites WHERE id = ?', siteId, 'Site');
    run('UPDATE rooms SET site_id = ?, code = ?, name = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?',
      siteId, b.code !== undefined ? reqStr(b.code, 'Code') : cur.code, b.name !== undefined ? reqStr(b.name, 'Room name') : cur.name,
      b.notes !== undefined ? optStr(b.notes) : cur.notes, bool01(b.active, cur.active), ts(), id);
    res.json(get('SELECT * FROM rooms WHERE id = ?', id));
  }));
  app.delete('/api/rooms/:id', h((req, res) => {
    const id = idParam(req);
    must('SELECT id FROM rooms WHERE id = ?', id, 'Room');
    const n = get('SELECT COUNT(*) AS n FROM equipment WHERE room_id = ?', id)!.n;
    if (n) throw new HttpError(409, `Cannot delete: this Room has ${n} equipment item(s). Archive it instead.`);
    run('DELETE FROM rooms WHERE id = ?', id);
    res.json({ ok: true });
  }));

  // ---------- users (directory contacts only; no logins) ----------
  const ROLES = ['Operator', 'Team Leader', 'Contact'];
  const userFields = (b: Row, cur?: Row) => {
    const email = b.email !== undefined ? optStr(b.email) : (cur?.email ?? '');
    if (email && !isEmail(email)) throw bad('Email address looks invalid');
    const role = b.role_label !== undefined ? String(b.role_label) : (cur?.role_label ?? 'Contact');
    if (!ROLES.includes(role)) throw bad(`Role must be one of ${ROLES.join(', ')}`);
    return {
      name: b.name !== undefined ? reqStr(b.name, 'Name') : cur?.name, email, role,
      team: b.team !== undefined ? optStr(b.team) : (cur?.team ?? ''), active: bool01(b.active, cur?.active ?? 1),
    };
  };
  app.get('/api/users', h((_req, res) => res.json(all('SELECT * FROM users ORDER BY active DESC, name'))));
  app.post('/api/users', h((req, res) => {
    const f = userFields(req.body ?? {});
    if (!f.name) throw bad('Name is required');
    const id = run('INSERT INTO users (name, email, team, role_label, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      f.name, f.email, f.team, f.role, f.active, ts(), ts()).lastInsertRowid;
    res.status(201).json(get('SELECT * FROM users WHERE id = ?', id));
  }));
  app.put('/api/users/:id', h((req, res) => {
    const id = idParam(req);
    const f = userFields(req.body ?? {}, must('SELECT * FROM users WHERE id = ?', id, 'User'));
    run('UPDATE users SET name = ?, email = ?, team = ?, role_label = ?, active = ?, updated_at = ? WHERE id = ?',
      f.name, f.email, f.team, f.role, f.active, ts(), id);
    res.json(get('SELECT * FROM users WHERE id = ?', id));
  }));

  // ---------- compliance types ----------
  const typeFields = (b: Row, cur?: Row) => {
    const warn = b.warning_days !== undefined && b.warning_days !== '' ? Number(b.warning_days) : (cur?.warning_days ?? Number(getSetting(db, 'warning_days')));
    if (!Number.isInteger(warn) || warn < 0) throw bad('Warning days must be a whole number ≥ 0');
    const interval = b.suggested_interval_months !== undefined ? optInt(b.suggested_interval_months, 'Interval') : (cur?.suggested_interval_months ?? null);
    if (interval !== null && interval <= 0) throw bad('Interval must be at least 1 month');
    return {
      code: b.code !== undefined ? reqStr(b.code, 'Code').toUpperCase() : cur?.code,
      name: b.name !== undefined ? reqStr(b.name, 'Name') : cur?.name,
      interval, warn,
      evidence: bool01(b.evidence_required, cur?.evidence_required ?? 1),
      active: bool01(b.active, cur?.active ?? 1),
      notes: b.notes !== undefined ? optStr(b.notes) : (cur?.notes ?? ''),
    };
  };
  app.get('/api/types', h((_req, res) => res.json(all(
    `SELECT t.*, (SELECT COUNT(*) FROM compliance_activities a WHERE a.type_id = t.id AND a.archived_at IS NULL) AS activity_count
     FROM compliance_types t ORDER BY t.active DESC, t.name`))));
  app.post('/api/types', h((req, res) => {
    const f = typeFields(req.body ?? {});
    if (!f.code || !f.name) throw bad('Code and name are required');
    const id = run(`INSERT INTO compliance_types (code, name, suggested_interval_months, warning_days, evidence_required, active, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.code, f.name, f.interval, f.warn, f.evidence, f.active, f.notes, ts(), ts()).lastInsertRowid;
    res.status(201).json(get('SELECT * FROM compliance_types WHERE id = ?', id));
  }));
  app.put('/api/types/:id', h((req, res) => {
    const id = idParam(req);
    const f = typeFields(req.body ?? {}, must('SELECT * FROM compliance_types WHERE id = ?', id, 'Compliance type'));
    run(`UPDATE compliance_types SET code = ?, name = ?, suggested_interval_months = ?, warning_days = ?, evidence_required = ?, active = ?, notes = ?, updated_at = ?
      WHERE id = ?`, f.code, f.name, f.interval, f.warn, f.evidence, f.active, f.notes, ts(), id);
    res.json(get('SELECT * FROM compliance_types WHERE id = ?', id));
  }));

  // ---------- equipment ----------
  const EQUIP_SELECT = `
    SELECT e.*, r.code AS room_code, r.name AS room_name, s.id AS site_id, s.code AS site_code, s.name AS site_name,
           ar.id AS area_id, ar.code AS area_code, ar.name AS area_name,
           (SELECT COUNT(*) FROM activity_equipment ae JOIN compliance_activities a ON a.id = ae.activity_id
             WHERE ae.equipment_id = e.id AND a.archived_at IS NULL) AS activity_count
    FROM equipment e JOIN rooms r ON r.id = e.room_id JOIN sites s ON s.id = r.site_id JOIN areas ar ON ar.id = s.area_id`;

  /** Is the equipment located inside the activity's chosen Area/Site/Room scope? */
  const inScope = (act: Row, equipmentId: number) => {
    const e = get('SELECT r.id AS room_id, s.id AS site_id, s.area_id FROM equipment e JOIN rooms r ON r.id = e.room_id JOIN sites s ON s.id = r.site_id WHERE e.id = ?', equipmentId);
    if (!e) return false;
    if (act.location_level === 'room') return e.room_id === act.room_id;
    if (act.location_level === 'site') return e.site_id === act.site_id;
    return e.area_id === act.area_id;
  };
  const scopeWhere = (level: Level, id: number): [string, number] =>
    level === 'room' ? ['r.id = ?', id] : level === 'site' ? ['s.id = ?', id] : ['ar.id = ?', id];

  app.get('/api/equipment', h((req, res) => {
    const level = req.query.level as Level | undefined;
    if (level && LEVELS.includes(level)) {
      const [w, p] = scopeWhere(level, reqInt(req.query.location_id, 'location_id'));
      return res.json(all(`${EQUIP_SELECT} WHERE ${w} ORDER BY e.asset_code`, p));
    }
    res.json(all(`${EQUIP_SELECT} ORDER BY e.asset_code`));
  }));
  app.get('/api/equipment/:id', h((req, res) => {
    const id = idParam(req);
    const e = get(`${EQUIP_SELECT} WHERE e.id = ?`, id);
    if (!e) throw notFound('Equipment');
    const acts = listActivities('a.id IN (SELECT activity_id FROM activity_equipment WHERE equipment_id = ?)', [id]);
    const actRows = all('SELECT a.* FROM compliance_activities a JOIN activity_equipment ae ON ae.activity_id = a.id WHERE ae.equipment_id = ?', id);
    const scope = new Map(actRows.map((a) => [a.id, inScope(a, id)]));
    res.json({ ...e, activities: acts.map((a) => ({ ...a, in_scope: scope.get(a.id) })) });
  }));
  app.post('/api/equipment', h((req, res) => {
    const b = req.body ?? {};
    const roomId = reqInt(b.room_id, 'Room (equipment must belong to a Room)');
    must('SELECT id FROM rooms WHERE id = ?', roomId, 'Room');
    const code = optStr(b.asset_code) || nextCode('equipment', 'asset_code', 'PH-E');
    const id = run(`INSERT INTO equipment (room_id, asset_code, description, category, serial_no, notes, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`, roomId, code, reqStr(b.description, 'Description'), optStr(b.category), optStr(b.serial_no) || null,
      optStr(b.notes), ts(), ts()).lastInsertRowid;
    res.status(201).json(get(`${EQUIP_SELECT} WHERE e.id = ?`, id));
  }));
  app.put('/api/equipment/:id', h((req, res) => {
    const id = idParam(req);
    const cur = must('SELECT * FROM equipment WHERE id = ?', id, 'Equipment');
    const b = req.body ?? {};
    const roomId = b.room_id !== undefined ? reqInt(b.room_id, 'Room') : cur.room_id;
    must('SELECT id FROM rooms WHERE id = ?', roomId, 'Room');
    run(`UPDATE equipment SET room_id = ?, asset_code = ?, description = ?, category = ?, serial_no = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?`,
      roomId, b.asset_code !== undefined ? reqStr(b.asset_code, 'Asset code') : cur.asset_code,
      b.description !== undefined ? reqStr(b.description, 'Description') : cur.description,
      b.category !== undefined ? optStr(b.category) : cur.category, b.serial_no !== undefined ? optStr(b.serial_no) || null : cur.serial_no,
      b.notes !== undefined ? optStr(b.notes) : cur.notes, bool01(b.active, cur.active), ts(), id);
    // Moving rooms must not silently break activity scope: report links that are now out of scope.
    const out = all('SELECT a.* FROM compliance_activities a JOIN activity_equipment ae ON ae.activity_id = a.id WHERE ae.equipment_id = ?', id)
      .filter((a) => !inScope(a, id)).map((a) => ({ id: a.id, ref: a.ref }));
    res.json({ ...get(`${EQUIP_SELECT} WHERE e.id = ?`, id), scope_warnings: out });
  }));
  app.delete('/api/equipment/:id', h((req, res) => {
    const id = idParam(req);
    must('SELECT id FROM equipment WHERE id = ?', id, 'Equipment');
    const n = get('SELECT COUNT(*) AS n FROM activity_equipment WHERE equipment_id = ?', id)!.n;
    if (n) throw new HttpError(409, `Cannot delete: linked to ${n} activit${n === 1 ? 'y' : 'ies'}. Unlink or archive instead.`);
    run("DELETE FROM document_links WHERE entity_kind = 'equipment' AND entity_id = ?", id);
    run('DELETE FROM equipment WHERE id = ?', id);
    res.json({ ok: true });
  }));

  // ---------- compliance activities ----------
  function listActivities(where = '1=1', params: unknown[] = [], includeArchived = false) {
    return all(
      `SELECT a.id, a.ref, a.name, a.location_level, a.type_id, t.code AS type_code, t.name AS type_name, t.evidence_required,
              ar.id AS area_id, ar.code AS area_code, ar.name AS area_name, s.id AS site_id, s.code AS site_code, s.name AS site_name,
              r.id AS room_id, r.code AS room_code, r.name AS room_name,
              a.owner_user_id, u.name AS owner_name, u.email AS owner_email,
              a.last_done_on, a.next_due_on, a.expires_on, a.interval_months, t.suggested_interval_months AS type_interval,
              a.applicability, a.na_reason, a.notes, a.archived_at, a.updated_at,
              (SELECT COUNT(*) FROM activity_equipment ae WHERE ae.activity_id = a.id) AS equipment_count,
              (SELECT GROUP_CONCAT(ae.equipment_id) FROM activity_equipment ae WHERE ae.activity_id = a.id) AS equipment_ids,
              (SELECT COUNT(*) FROM document_links l WHERE l.entity_kind = 'activity' AND l.entity_id = a.id) AS doc_count,
              (SELECT COUNT(*) FROM document_links l JOIN documents d ON d.id = l.document_id
                 WHERE l.entity_kind = 'activity' AND l.entity_id = a.id AND d.verified_by_operator = 1) AS verified_doc_count,
              (SELECT COUNT(*) FROM actions x WHERE x.activity_id = a.id AND x.state <> 'Done') AS open_actions,
              snap.status, snap.days_to_due, snap.due_on AS snap_due_on, snap.reason AS status_reason
       FROM compliance_activities a
       JOIN compliance_types t ON t.id = a.type_id
       LEFT JOIN users u ON u.id = a.owner_user_id
       ${ACTIVITY_LOCATION_JOINS}
       LEFT JOIN activity_status_snapshots snap ON snap.activity_id = a.id AND snap.run_id = (SELECT MAX(id) FROM recalculation_runs)
       WHERE (${where}) ${includeArchived ? '' : 'AND a.archived_at IS NULL'}
       ORDER BY a.ref`,
      ...params,
    ).map((a): Row => ({ ...a, equipment_ids: a.equipment_ids ? String(a.equipment_ids).split(',').map(Number) : [] }));
  }

  const activityFields = (b: Row, cur?: Row) => {
    const typeId = b.type_id !== undefined ? reqInt(b.type_id, 'Compliance type') : cur?.type_id;
    if (!typeId) throw bad('Compliance type is required');
    must('SELECT id FROM compliance_types WHERE id = ?', typeId, 'Compliance type');
    const level = (b.location_level ?? cur?.location_level) as Level;
    if (!LEVELS.includes(level)) throw bad('Choose a location level: Area, Site or Room');
    const locId = b.location_id !== undefined ? reqInt(b.location_id, `${level} location`) : cur?.[`${level}_id`];
    if (!locId) throw bad(`Choose the ${level} this activity applies to`);
    must(`SELECT id FROM ${LEVEL_TABLE[level]} WHERE id = ?`, locId, level[0].toUpperCase() + level.slice(1));
    const ownerId = b.owner_user_id !== undefined ? optInt(b.owner_user_id, 'Responsible person') : (cur?.owner_user_id ?? null);
    if (ownerId !== null) must('SELECT id FROM users WHERE id = ?', ownerId, 'Responsible person');
    const pick = <T>(k: string, f: (v: unknown) => T, d: T): T => (b[k] !== undefined ? f(b[k]) : (cur?.[k] ?? d));
    const applicability = pick('applicability', (v) => String(v), 'required');
    if (!['required', 'not_applicable', 'unknown'].includes(applicability)) throw bad('Invalid applicability');
    const interval = pick('interval_months', (v) => optInt(v, 'Interval'), null as number | null);
    if (interval !== null && interval <= 0) throw bad('Interval must be at least 1 month');
    return {
      type_id: typeId, location_level: level,
      area_id: level === 'area' ? locId : null, site_id: level === 'site' ? locId : null, room_id: level === 'room' ? locId : null,
      owner_user_id: ownerId,
      name: pick('name', optStr, ''),
      last_done_on: pick('last_done_on', (v) => optDate(v, 'Last done'), null),
      next_due_on: pick('next_due_on', (v) => optDate(v, 'Next due'), null),
      expires_on: pick('expires_on', (v) => optDate(v, 'Expiry'), null),
      interval_months: interval, applicability,
      na_reason: pick('na_reason', optStr, ''),
      notes: pick('notes', optStr, ''),
    };
  };

  const activityDetail = (id: number) => {
    const a = listActivities('a.id = ?', [id], true)[0];
    if (!a) throw notFound('Activity');
    const raw = get('SELECT * FROM compliance_activities WHERE id = ?', id)!;
    const equipment = all(`${EQUIP_SELECT} WHERE e.id IN (SELECT equipment_id FROM activity_equipment WHERE activity_id = ?) ORDER BY e.asset_code`, id)
      .map((e) => ({ ...e, in_scope: inScope(raw, e.id) }));
    const actions = all(`SELECT x.*, u.name AS owner_name FROM actions x LEFT JOIN users u ON u.id = x.owner_user_id WHERE x.activity_id = ? ORDER BY x.id DESC`, id);
    return { ...a, equipment, actions };
  };

  const linkEquipment = (activityId: number, ids: unknown[]) => {
    const act = must('SELECT * FROM compliance_activities WHERE id = ?', activityId, 'Activity');
    const ins = db.prepare('INSERT OR IGNORE INTO activity_equipment (activity_id, equipment_id, created_at) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (const raw of ids) {
        const eid = reqInt(raw, 'Equipment');
        const e = get(`${EQUIP_SELECT} WHERE e.id = ?`, eid);
        if (!e) throw notFound(`Equipment ${eid}`);
        if (!inScope(act, eid)) {
          throw bad(`${e.asset_code} is in ${e.site_code} / ${e.room_code}, which is outside this activity's ${act.location_level} scope. ` +
            'Only equipment located within the selected location can be linked.');
        }
        ins.run(activityId, eid, ts());
      }
    })();
  };

  app.get('/api/activities', h((req, res) => res.json(listActivities('1=1', [], req.query.archived === '1'))));
  app.get('/api/activities/:id', h((req, res) => res.json(activityDetail(idParam(req)))));
  app.post('/api/activities', h((req, res) => {
    const b = req.body ?? {};
    const f = activityFields(b);
    const id = db.transaction(() => {
      const newId = Number(run(
        `INSERT INTO compliance_activities (ref, type_id, name, location_level, area_id, site_id, room_id, owner_user_id, last_done_on, next_due_on,
           expires_on, interval_months, applicability, na_reason, notes, created_at, updated_at)
         VALUES (@ref, @type_id, @name, @location_level, @area_id, @site_id, @room_id, @owner_user_id, @last_done_on, @next_due_on,
           @expires_on, @interval_months, @applicability, @na_reason, @notes, @ts, @ts)`,
        { ...f, ref: optStr(b.ref) || nextCode('compliance_activities', 'ref', 'PH-C'), ts: ts() },
      ).lastInsertRowid);
      if (Array.isArray(b.equipment_ids) && b.equipment_ids.length) linkEquipment(newId, b.equipment_ids);
      return newId;
    })();
    res.status(201).json(activityDetail(id));
  }));
  app.put('/api/activities/:id', h((req, res) => {
    const id = idParam(req);
    const cur = must('SELECT * FROM compliance_activities WHERE id = ?', id, 'Activity');
    const f = activityFields(req.body ?? {}, cur);
    run(`UPDATE compliance_activities SET type_id = @type_id, name = @name, location_level = @location_level, area_id = @area_id, site_id = @site_id,
           room_id = @room_id, owner_user_id = @owner_user_id, last_done_on = @last_done_on, next_due_on = @next_due_on, expires_on = @expires_on,
           interval_months = @interval_months, applicability = @applicability, na_reason = @na_reason, notes = @notes, updated_at = @ts
         WHERE id = @id`, { ...f, id, ts: ts() });
    res.json(activityDetail(id));
  }));
  app.post('/api/activities/:id/archive', h((req, res) => {
    const id = idParam(req);
    must('SELECT id FROM compliance_activities WHERE id = ?', id, 'Activity');
    run('UPDATE compliance_activities SET archived_at = ?, updated_at = ? WHERE id = ?', req.body?.archived === false ? null : ts(), ts(), id);
    res.json(activityDetail(id));
  }));
  app.post('/api/activities/:id/equipment', h((req, res) => {
    const id = idParam(req);
    const ids = req.body?.equipment_ids;
    if (!Array.isArray(ids) || !ids.length) throw bad('equipment_ids must be a non-empty list');
    linkEquipment(id, ids);
    res.json(activityDetail(id));
  }));
  app.delete('/api/activities/:id/equipment/:equipmentId', h((req, res) => {
    const id = idParam(req);
    run('DELETE FROM activity_equipment WHERE activity_id = ? AND equipment_id = ?', id, Number(req.params.equipmentId));
    res.json(activityDetail(id));
  }));
  app.get('/api/activities/:id/history', h((req, res) => {
    const id = idParam(req);
    res.json({
      snapshots: all(`SELECT s.*, r.created_at AS run_at, r.as_of_date FROM activity_status_snapshots s JOIN recalculation_runs r ON r.id = s.run_id
        WHERE s.activity_id = ? ORDER BY s.run_id DESC LIMIT 50`, id),
      emails: all(`SELECT l.* FROM email_log l JOIN reminder_candidates c ON c.id = l.candidate_id WHERE c.activity_id = ? ORDER BY l.id DESC`, id),
    });
  }));

  // ---------- location detail (Area / Site front sheet / Room) ----------
  app.get('/api/locations/:kind/:id', h((req, res) => {
    const kind = req.params.kind as Level;
    if (!LEVELS.includes(kind)) throw bad('Unknown location kind');
    const id = idParam(req);
    const entity = must(`SELECT * FROM ${LEVEL_TABLE[kind]} WHERE id = ?`, id, kind);
    let breadcrumb: Row[] = [];
    let direct: Row[] = [], inherited: Row[] = [], children: Row[] = [];
    let equipment: Row[] = [];
    const relatedKinds: [string, number[]][] = [];
    if (kind === 'area') {
      breadcrumb = [{ kind: 'area', ...entity }];
      direct = listActivities('ar.id = ?', [id]);
      children = listSites().filter((s) => s.area_id === id);
      equipment = all(`${EQUIP_SELECT} WHERE ar.id = ? ORDER BY e.asset_code`, id);
      relatedKinds.push(['site', children.map((s) => s.id)]);
    } else if (kind === 'site') {
      const area = get('SELECT * FROM areas WHERE id = ?', entity.area_id)!;
      breadcrumb = [{ kind: 'area', ...area }, { kind: 'site', ...entity }];
      direct = listActivities('s.id = ?', [id]);
      inherited = listActivities("a.location_level = 'area' AND a.area_id = ?", [entity.area_id]);
      children = listRooms().filter((r) => r.site_id === id);
      equipment = all(`${EQUIP_SELECT} WHERE s.id = ? ORDER BY e.asset_code`, id);
      relatedKinds.push(['room', children.map((r) => r.id)]);
    } else {
      const site = get('SELECT * FROM sites WHERE id = ?', entity.site_id)!;
      const area = get('SELECT * FROM areas WHERE id = ?', site.area_id)!;
      breadcrumb = [{ kind: 'area', ...area }, { kind: 'site', ...site }, { kind: 'room', ...entity }];
      direct = listActivities('r.id = ?', [id]);
      inherited = listActivities("(a.location_level = 'site' AND a.site_id = ?) OR (a.location_level = 'area' AND a.area_id = ?)", [site.id, area.id]);
      equipment = all(`${EQUIP_SELECT} WHERE r.id = ? ORDER BY e.asset_code`, id);
    }
    relatedKinds.push(['activity', direct.map((a) => a.id)], ['equipment', equipment.map((e) => e.id)]);
    const related: Row[] = [];
    for (const [k, ids] of relatedKinds) {
      if (!ids.length) continue;
      for (const d of all(`SELECT d.*, l.entity_kind, l.entity_id, l.link_role FROM document_links l JOIN documents d ON d.id = l.document_id
          WHERE l.entity_kind = ? AND l.entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY d.uploaded_at DESC`, k, ...ids)) {
        related.push({ ...d, via: entityLabel(d.entity_kind, d.entity_id) });
      }
    }
    res.json({ kind, entity, breadcrumb, activities: direct, inherited, children, equipment, relatedDocuments: related });
  }));

  // ---------- documents (central library) ----------
  function entityLabel(kind: string, id: number): { kind: string; id: number; label: string; href: string } {
    const r = (sql: string) => get(sql, id);
    let label = `${kind} #${id} (missing)`;
    let href = '';
    if (kind === 'area') { const x = r('SELECT code, name FROM areas WHERE id = ?'); if (x) { label = `${x.code} ${x.name}`; href = `#/areas/${id}`; } }
    if (kind === 'site') { const x = r('SELECT code, name FROM sites WHERE id = ?'); if (x) { label = `${x.code} ${x.name}`; href = `#/sites/${id}`; } }
    if (kind === 'room') { const x = r('SELECT r.code, r.name, s.code AS sc FROM rooms r JOIN sites s ON s.id = r.site_id WHERE r.id = ?'); if (x) { label = `${x.code} ${x.name} (${x.sc})`; href = `#/rooms/${id}`; } }
    if (kind === 'equipment') { const x = r('SELECT asset_code, description FROM equipment WHERE id = ?'); if (x) { label = `${x.asset_code} ${x.description}`; href = `#/equipment/${id}`; } }
    if (kind === 'activity') { const x = r('SELECT a.ref, t.name FROM compliance_activities a JOIN compliance_types t ON t.id = a.type_id WHERE a.id = ?'); if (x) { label = `${x.ref} ${x.name}`; href = `#/activities/${id}`; } }
    if (kind === 'action') { const x = r('SELECT title FROM actions WHERE id = ?'); if (x) { label = `Action: ${x.title}`; href = '#/actions'; } }
    if (kind === 'inspection') { const x = r('SELECT inspected_on FROM inspection_runs WHERE id = ?'); if (x) { label = `Inspection ${x.inspected_on}`; href = '#/inspections'; } }
    return { kind, id, label, href };
  }
  const docLinks = (docId: number) =>
    all('SELECT * FROM document_links WHERE document_id = ? ORDER BY id', docId).map((l) => ({ ...l, ...entityLabel(l.entity_kind, l.entity_id), id: l.id }));
  const docWithLinks = (d: Row) => ({ ...d, links: docLinks(d.id) });
  const assertEntity = (kind: unknown, id: unknown) => {
    if (!ENTITY_KINDS.includes(kind as EntityKind)) throw bad(`entity_kind must be one of ${ENTITY_KINDS.join(', ')}`);
    const eid = reqInt(id, 'entity_id');
    if (!get(`SELECT id FROM ${ENTITY_TABLE[kind as EntityKind]} WHERE id = ?`, eid)) throw notFound(`Linked ${kind} ${eid}`);
    return { kind: kind as EntityKind, id: eid };
  };
  const addLink = (docId: number, kind: EntityKind, id: number, role: string) =>
    run('INSERT OR IGNORE INTO document_links (document_id, entity_kind, entity_id, link_role, created_at) VALUES (?, ?, ?, ?, ?)', docId, kind, id, role || 'evidence', ts());

  app.get('/api/documents', h((req, res) => {
    if (req.query.entity_kind) {
      const e = assertEntity(req.query.entity_kind, req.query.entity_id);
      const docs = all(`SELECT d.*, l.id AS link_id, l.link_role FROM document_links l JOIN documents d ON d.id = l.document_id
        WHERE l.entity_kind = ? AND l.entity_id = ? ORDER BY d.uploaded_at DESC`, e.kind, e.id);
      return res.json(docs.map(docWithLinks));
    }
    res.json(all('SELECT * FROM documents ORDER BY uploaded_at DESC, id DESC').map(docWithLinks));
  }));
  app.get('/api/documents/:id', h((req, res) => res.json(docWithLinks(must('SELECT * FROM documents WHERE id = ?', idParam(req), 'Document')))));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  app.post('/api/documents', upload.single('file'), h((req, res) => {
    const file = req.file;
    if (!file) throw bad('Choose a file to upload');
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) throw bad(`File type ${ext || '(none)'} not allowed. Allowed: ${Object.keys(MIME_BY_EXT).join(' ')}`);
    const b = req.body ?? {};
    const target = b.entity_kind ? assertEntity(b.entity_kind, b.entity_id) : null; // validate BEFORE storing bytes
    const issued = optDate(b.issued_on, 'Issued on');
    const validUntil = optDate(b.valid_until, 'Valid until');
    const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const existing = get('SELECT * FROM documents WHERE sha256 = ? AND size_bytes = ?', sha, file.size);
    let docId: number;
    let reused = false;
    if (existing) {
      // Same bytes already in the library: link the existing document instead of storing a duplicate.
      docId = existing.id;
      reused = true;
    } else {
      const key = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(uploadsDir, key), file.buffer, { flag: 'wx' });
      const safeName = path.basename(file.originalname).replace(/[\r\n"]/g, '_').slice(0, 200);
      docId = Number(run(`INSERT INTO documents (display_name, storage_key, original_filename, mime_type, size_bytes, sha256, uploaded_at, issued_on, valid_until,
          verified_by_operator, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        optStr(b.display_name) || safeName, key, safeName, mime, file.size, sha, ts(), issued, validUntil, optStr(b.notes)).lastInsertRowid);
    }
    if (target) addLink(docId, target.kind, target.id, optStr(b.link_role));
    res.status(reused ? 200 : 201).json({ ...docWithLinks(get('SELECT * FROM documents WHERE id = ?', docId)!), reused });
  }));
  app.put('/api/documents/:id', h((req, res) => {
    const id = idParam(req);
    const cur = must('SELECT * FROM documents WHERE id = ?', id, 'Document');
    const b = req.body ?? {};
    const verified = b.verified_by_operator !== undefined ? bool01(b.verified_by_operator) : cur.verified_by_operator;
    run('UPDATE documents SET display_name = ?, issued_on = ?, valid_until = ?, notes = ?, verified_by_operator = ?, verified_at = ? WHERE id = ?',
      b.display_name !== undefined ? reqStr(b.display_name, 'Title') : cur.display_name,
      b.issued_on !== undefined ? optDate(b.issued_on, 'Issued on') : cur.issued_on,
      b.valid_until !== undefined ? optDate(b.valid_until, 'Valid until') : cur.valid_until,
      b.notes !== undefined ? optStr(b.notes) : cur.notes,
      verified, verified ? (cur.verified_by_operator ? cur.verified_at : ts()) : null, id);
    res.json(docWithLinks(get('SELECT * FROM documents WHERE id = ?', id)!));
  }));
  app.delete('/api/documents/:id', h((req, res) => {
    const id = idParam(req);
    const d = must('SELECT * FROM documents WHERE id = ?', id, 'Document');
    const n = get('SELECT COUNT(*) AS n FROM document_links WHERE document_id = ?', id)!.n;
    if (n) throw new HttpError(409, `Cannot delete: document is linked to ${n} record(s). Unlink first.`);
    run('DELETE FROM documents WHERE id = ?', id);
    if (STORAGE_KEY_RE.test(d.storage_key)) fs.rmSync(path.join(uploadsDir, d.storage_key), { force: true });
    res.json({ ok: true });
  }));
  app.get('/api/documents/:id/file', h((req, res) => {
    const d = must('SELECT * FROM documents WHERE id = ?', idParam(req), 'Document');
    if (!STORAGE_KEY_RE.test(d.storage_key)) throw new HttpError(500, 'Invalid storage key');
    const file = path.join(uploadsDir, d.storage_key);
    if (!fs.existsSync(file)) throw notFound('Stored file');
    const disp = INLINE_MIME.test(d.mime_type) && req.query.download !== '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', d.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(d.original_filename)}`);
    fs.createReadStream(file).pipe(res);
  }));
  app.post('/api/documents/:id/links', h((req, res) => {
    const id = idParam(req);
    must('SELECT id FROM documents WHERE id = ?', id, 'Document');
    const e = assertEntity(req.body?.entity_kind, req.body?.entity_id);
    addLink(id, e.kind, e.id, optStr(req.body?.link_role));
    res.status(201).json(docWithLinks(get('SELECT * FROM documents WHERE id = ?', id)!));
  }));
  app.delete('/api/document-links/:id', h((req, res) => {
    const id = idParam(req);
    const l = must('SELECT * FROM document_links WHERE id = ?', id, 'Document link');
    run('DELETE FROM document_links WHERE id = ?', id);
    res.json(docWithLinks(get('SELECT * FROM documents WHERE id = ?', l.document_id)!));
  }));
  /** Lightweight list of every linkable record for pickers. */
  app.get('/api/linkables', h((_req, res) => {
    res.json([
      ...all('SELECT id, code, name FROM areas ORDER BY code').map((x) => ({ kind: 'area', id: x.id, label: `${x.code} ${x.name}` })),
      ...all('SELECT id, code, name FROM sites ORDER BY code').map((x) => ({ kind: 'site', id: x.id, label: `${x.code} ${x.name}` })),
      ...all('SELECT r.id, r.code, r.name, s.code AS sc FROM rooms r JOIN sites s ON s.id = r.site_id ORDER BY r.code').map((x) => ({ kind: 'room', id: x.id, label: `${x.code} ${x.name} (${x.sc})` })),
      ...all('SELECT id, asset_code, description FROM equipment ORDER BY asset_code').map((x) => ({ kind: 'equipment', id: x.id, label: `${x.asset_code} ${x.description}` })),
      ...all('SELECT a.id, a.ref, t.name FROM compliance_activities a JOIN compliance_types t ON t.id = a.type_id WHERE a.archived_at IS NULL ORDER BY a.ref').map((x) => ({ kind: 'activity', id: x.id, label: `${x.ref} ${x.name}` })),
      ...all('SELECT id, title FROM actions ORDER BY id DESC').map((x) => ({ kind: 'action', id: x.id, label: `Action: ${x.title}` })),
    ]);
  }));

  // ---------- actions (minimal P0 register; full workflow is P1) ----------
  const ACTION_SELECT = `SELECT x.*, a.ref AS activity_ref, s.code AS site_code, u.name AS owner_name FROM actions x
    LEFT JOIN compliance_activities a ON a.id = x.activity_id LEFT JOIN sites s ON s.id = x.site_id LEFT JOIN users u ON u.id = x.owner_user_id`;
  const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
  const STATES = ['Open', 'In progress', 'Done'];
  app.get('/api/actions', h((_req, res) => res.json(all(`${ACTION_SELECT} ORDER BY CASE x.state WHEN 'Done' THEN 1 ELSE 0 END, x.due_on IS NULL, x.due_on`))));
  app.post('/api/actions', h((req, res) => {
    const b = req.body ?? {};
    const activityId = optInt(b.activity_id, 'Activity');
    let siteId = optInt(b.site_id, 'Site');
    if (activityId !== null) {
      const a = listActivities('a.id = ?', [activityId], true)[0];
      if (!a) throw notFound('Activity');
      siteId = siteId ?? (a.site_id || null);
    }
    if (siteId !== null) must('SELECT id FROM sites WHERE id = ?', siteId, 'Site');
    const priority = b.priority ? String(b.priority) : 'Medium';
    if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
    const owner = optInt(b.owner_user_id, 'Owner');
    if (owner !== null) must('SELECT id FROM users WHERE id = ?', owner, 'Owner');
    const id = run(`INSERT INTO actions (activity_id, site_id, title, priority, owner_user_id, due_on, state, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?)`, activityId, siteId, reqStr(b.title, 'Title'), priority, owner, optDate(b.due_on, 'Due'), optStr(b.notes), ts(), ts()).lastInsertRowid;
    res.status(201).json(get(`${ACTION_SELECT} WHERE x.id = ?`, id));
  }));
  app.put('/api/actions/:id', h((req, res) => {
    const id = idParam(req);
    const cur = must('SELECT * FROM actions WHERE id = ?', id, 'Action');
    const b = req.body ?? {};
    const state = b.state !== undefined ? String(b.state) : cur.state;
    const priority = b.priority !== undefined ? String(b.priority) : cur.priority;
    if (!STATES.includes(state)) throw bad('Invalid state');
    if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
    run('UPDATE actions SET title = ?, priority = ?, state = ?, due_on = ?, owner_user_id = ?, notes = ?, closed_at = ?, updated_at = ? WHERE id = ?',
      b.title !== undefined ? reqStr(b.title, 'Title') : cur.title, priority, state,
      b.due_on !== undefined ? optDate(b.due_on, 'Due') : cur.due_on,
      b.owner_user_id !== undefined ? optInt(b.owner_user_id, 'Owner') : cur.owner_user_id,
      b.notes !== undefined ? optStr(b.notes) : cur.notes,
      state === 'Done' ? (cur.closed_at ?? ts()) : null, ts(), id);
    res.json(get(`${ACTION_SELECT} WHERE x.id = ?`, id));
  }));

  app.get('/api/checklist', h((_req, res) => res.json(all('SELECT * FROM checklist_questions ORDER BY sort_order'))));

  // ---------- manual recalculation ----------
  app.post('/api/recalculate', h((_req, res) => {
    const r = recalculate(db, now());
    res.json(r);
  }));

  // ---------- reminders (generated by Recalculate; sending is a separate manual click) ----------
  const CAND_SELECT = `SELECT c.*, a.ref AS activity_ref, t.name AS type_name, s.code AS site_code, r.code AS room_code, ar.code AS area_code,
      (SELECT MAX(l.sent_at) FROM email_log l WHERE l.message_key = c.message_key AND l.outcome = 'sent') AS already_sent_at,
      (SELECT l.outcome || ': ' || l.detail FROM email_log l WHERE l.candidate_id = c.id ORDER BY l.id DESC LIMIT 1) AS last_outcome
    FROM reminder_candidates c JOIN compliance_activities a ON a.id = c.activity_id JOIN compliance_types t ON t.id = a.type_id
    ${ACTIVITY_LOCATION_JOINS}`;
  app.get('/api/reminders', h((_req, res) => {
    const r = latestRun(db);
    if (!r) return res.json({ run: null, candidates: [] });
    res.json({ run: { id: r.id, createdAt: r.created_at, asOfDate: r.as_of_date }, candidates: all(`${CAND_SELECT} WHERE c.run_id = ? ORDER BY c.days_to_due, c.id`, r.id) });
  }));
  app.patch('/api/reminders/:id', h((req, res) => {
    const id = idParam(req);
    const c = must('SELECT * FROM reminder_candidates WHERE id = ?', id, 'Reminder');
    const b = req.body ?? {};
    run('UPDATE reminder_candidates SET selected = ?, subject = ?, draft_text = ? WHERE id = ?',
      b.selected !== undefined ? bool01(b.selected) : c.selected,
      b.subject !== undefined ? reqStr(b.subject, 'Subject') : c.subject,
      b.draft_text !== undefined ? reqStr(b.draft_text, 'Message') : c.draft_text, id);
    res.json(get(`${CAND_SELECT} WHERE c.id = ?`, id));
  }));
  const idsFrom = (b: Row) => {
    if (!Array.isArray(b?.ids) || !b.ids.length) throw bad('Select at least one reminder');
    return b.ids.map((x: unknown) => reqInt(x, 'Reminder id'));
  };
  app.post('/api/reminders/send', h((req, res) => {
    const results = sendReminders(db, outboxDir, idsFrom(req.body), { message: optStr(req.body.message), resend: req.body.resend === true, now: now() });
    res.json({ mode: 'demo', note: 'Demo adapter: messages written to the local outbox folder only. No real email was sent.', results });
  }));
  app.post('/api/reminders/export', h((req, res) => {
    const results = exportDrafts(db, path.join(outboxDir, 'drafts'), idsFrom(req.body), { message: optStr(req.body.message), now: now() });
    res.json({ results, folder: path.join(outboxDir, 'drafts') });
  }));
  app.get('/api/reminders/:id/eml', h((req, res) => {
    const c = must('SELECT * FROM reminder_candidates WHERE id = ?', idParam(req), 'Reminder') as CandidateRow;
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="reminder-${c.id}-draft.eml"`);
    res.send(candidateEml(c, String(req.query.message ?? ''), now(), true));
  }));
  app.get('/api/email-log', h((_req, res) => res.json(all('SELECT * FROM email_log ORDER BY id DESC LIMIT 200'))));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));
  app.use(errorMiddleware);
  return app;
}
