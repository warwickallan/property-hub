import { useEffect, useMemo, useState } from 'react';
import { api, type Core, type Row } from '../api';
import { Card, DataTable, DocumentsPanel, ErrorBox, Field, Loading, Modal, Page, StatusChip, Tabs } from '../components';
import { addMonths, fmtDate, hashParams, LEVEL_LABEL, navigate, useLoad } from '../util';
import { ACTION_COLS, ActionModal } from './Actions';
import { ActivityHistory } from './Checks';

function Crumbs({ a }: { a: Row }) {
  return (
    <>
      <a href="#/activities">Compliance Activities</a> ›{' '}
      <a href={`#/areas/${a.area_id}`}>{a.area_code} {a.area_name}</a>
      {a.site_id && <> › <a href={`#/sites/${a.site_id}`}>{a.site_code} {a.site_name}</a></>}
      {a.room_id && <> › <a href={`#/rooms/${a.room_id}`}>{a.room_code} {a.room_name}</a></>}
    </>
  );
}

export function ActivityDetail({ id }: { id: number }) {
  const { data: a, error, reload } = useLoad<Row>(`/api/activities/${id}`);
  const params = hashParams();
  const [tab, setTab] = useState(params.get('tab') ?? 'overview');
  const [err, setErr] = useState<string | null>(null);
  const flash = params.get('msg');
  if (error) return <ErrorBox error={error} />;
  if (!a) return <Loading />;
  const archive = async () => {
    setErr(null);
    try {
      await api.post(`/api/activities/${id}/archive`, { archived: !!a.archived_at ? false : true });
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Page
      crumbs={<Crumbs a={a} />}
      title={<>{a.ref} · {a.type_name}{a.name ? ` — ${a.name}` : ''} {a.archived_at && <span className="chip chip-none">Archived</span>}</>}
      actions={
        <>
          {!a.archived_at && <a className="btn btn-primary btn-lg" href={`#/activities/${id}/check`}>Record Inspection / Check</a>}
          <a className="btn" href={`#/activities/${id}/edit`}>Edit</a>
          <button onClick={archive}>{a.archived_at ? 'Restore' : 'Archive'}</button>
        </>
      }
    >
      <ErrorBox error={err} />
      {flash === 'recorded' && <div className="note ok-note">Inspection / check recorded and the schedule updated. <strong>Changes pending</strong> — click Recalculate Compliance to update the status.</div>}
      {flash === 'amended' && <div className="note ok-note">Amendment recorded. The original record is kept and marked as superseded. Click Recalculate Compliance to update the status.</div>}
      {flash === 'saved' && <div className="note ok-note">Saved. <strong>Changes pending</strong> — the status updates when you click Recalculate Compliance.</div>}
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'overview', label: 'Overview & Schedule' },
          { key: 'equipment', label: 'Linked Equipment', count: a.equipment.length },
          { key: 'documents', label: 'Documents', count: a.doc_count },
          { key: 'history', label: 'Inspection & Check History', count: a.check_count },
          { key: 'actions', label: 'Actions', count: a.actions.length },
        ]}
      />
      {tab === 'overview' && <Overview a={a} />}
      {tab === 'equipment' && <LinkedEquipment a={a} onChange={reload} />}
      {tab === 'documents' && <DocumentsPanel kind="activity" id={id} title="Evidence documents" />}
      {tab === 'history' && <ActivityHistory a={a} />}
      {tab === 'actions' && <ActivityActions a={a} onChange={reload} />}
    </Page>
  );
}

function Overview({ a }: { a: Row }) {
  const interval = a.effective_interval;
  const stale = a.status && (a.snap_due_on ?? null) !== (a.next_due_on ?? null);
  const rows: [string, React.ReactNode][] = [
    ['Compliance type', `${a.type_code} — ${a.type_name}`],
    ['Location level', LEVEL_LABEL[a.location_level]],
    ['Location', [a.area_code, a.site_code, a.room_code].filter(Boolean).join(' › ')],
    ['Responsible', a.owner_name ? `${a.owner_name}${a.owner_email ? ` <${a.owner_email}>` : ' (no email)'}` : '—'],
    ['Applicability', a.applicability === 'not_applicable' ? `Not applicable — ${a.na_reason || 'no reason'}` : a.applicability === 'unknown' ? 'Unknown' : 'Required'],
    ['Last inspection / check', <>{fmtDate(a.last_done_on)}{a.latest_check && <span className="muted small"> · latest record {a.latest_check.ref} ({a.latest_check.outcome})</span>}</>],
    ['Interval', interval ? `${interval} months${a.interval_months ? '' : ' (type default)'}` : '—'],
    ['Next due', a.next_due_override
      ? <><strong>{fmtDate(a.next_due_on)}</strong> <span className="override-tag">Override</span><div className="muted small">{a.next_due_override_reason}{a.derived_next_due ? ` · calculated would be ${fmtDate(a.derived_next_due)}` : ''}</div></>
      : <><strong>{fmtDate(a.next_due_on)}</strong>{a.next_due_on && <span className="muted small"> · calculated: last done + {interval} months</span>}</>],
    ['Expires', fmtDate(a.expires_on)],
    ['Evidence required', a.evidence_required ? 'Yes — verified document needed' : 'No'],
    ['Evidence', `${a.doc_count} linked, ${a.verified_doc_count} verified`],
    ['Notes', a.notes || '—'],
  ];
  return (
    <div className="grid2">
      <Card title="Status snapshot">
        <p><StatusChip status={a.status} /></p>
        <p>{a.status ? a.status_reason : 'Not yet calculated — click Recalculate Compliance.'}</p>
        {a.status && <p className="muted small">Due date used in this snapshot {fmtDate(a.snap_due_on)} · days to due {a.days_to_due ?? '—'}</p>}
        {stale && <div className="note">The schedule now says next due <strong>{fmtDate(a.next_due_on)}</strong>. Click <strong>Recalculate Compliance</strong> to update this status.</div>}
        <p className="muted small">Status only changes when you click Recalculate. Edits since the last run are shown as "Changes pending" in the header.</p>
      </Card>
      <Card title="Overview & schedule">
        <dl className="dl">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </Card>
    </div>
  );
}

function LinkedEquipment({ a, onChange }: { a: Row; onChange: () => void }) {
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const locId = a[`${a.location_level}_id`];
  const remove = async (eid: number) => {
    setErr(null);
    try {
      await api.del(`/api/activities/${a.id}/equipment/${eid}`);
      onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const bad = a.equipment.filter((e: Row) => !e.in_scope);
  return (
    <Card title="Linked equipment" actions={<button onClick={() => setPicking(true)}>+ Link equipment</button>}>
      <ErrorBox error={err} />
      {bad.length > 0 && <div className="error">⚠ {bad.length} linked item(s) are now outside this activity's {a.location_level} scope (equipment was moved). Review and unlink or change the activity location.</div>}
      {a.equipment.length === 0 && <p className="muted">No equipment linked. That's fine for location-wide activities (e.g. a site FRA).</p>}
      {a.equipment.length > 0 && (
        <DataTable
          rows={a.equipment}
          onRowClick={(e) => navigate(`#/equipment/${e.id}`)}
          cols={[
            { key: 'asset_code', label: 'Asset' },
            { key: 'description', label: 'Description' },
            { key: 'category', label: 'Category' },
            { key: 'room', label: 'Room', render: (e) => `${e.site_code} › ${e.room_code} ${e.room_name}` },
            { key: 'in_scope', label: 'Scope', render: (e) => (e.in_scope ? <span className="ok">In scope</span> : <span className="warn">Out of scope</span>) },
            { key: 'x', label: '', render: (e) => <button className="btn-ghost small" onClick={(ev) => { ev.stopPropagation(); remove(e.id); }}>Unlink</button> },
          ]}
        />
      )}
      {picking && (
        <EquipmentPicker
          level={a.location_level}
          locationId={locId}
          exclude={new Set(a.equipment.map((e: Row) => e.id))}
          onClose={() => setPicking(false)}
          onPick={async (ids) => {
            setErr(null);
            try {
              await api.post(`/api/activities/${a.id}/equipment`, { equipment_ids: ids });
              setPicking(false);
              onChange();
            } catch (e: any) {
              setErr(e.message);
              setPicking(false);
            }
          }}
        />
      )}
    </Card>
  );
}

export function EquipmentPicker({ level, locationId, exclude, onClose, onPick }: {
  level: string; locationId: number; exclude: Set<number>; onClose: () => void; onPick: (ids: number[]) => void;
}) {
  const { data } = useLoad<Row[]>(`/api/equipment?level=${level}&location_id=${locationId}`);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const rows = (data ?? []).filter((e) => !exclude.has(e.id) && `${e.asset_code} ${e.description} ${e.category} ${e.room_code} ${e.room_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={`Link equipment within this ${level}`} onClose={onClose}>
      <p className="muted small">Only equipment located inside the activity's {level} is offered.</p>
      <input autoFocus className="wide" placeholder="Search asset tag, type, room…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pick-list">
        {rows.map((e) => (
          <label key={e.id} className="pick-row">
            <input type="checkbox" checked={sel.has(e.id)} onChange={(ev) => {
              const n = new Set(sel);
              ev.target.checked ? n.add(e.id) : n.delete(e.id);
              setSel(n);
            }} />
            <strong>{e.asset_code}</strong> {e.description} <span className="muted small">{e.category} · {e.room_code} {e.room_name}</span>
          </label>
        ))}
        {data && !rows.length && <p className="muted">No (more) equipment in scope.</p>}
      </div>
      <div className="form-actions">
        <button className="btn-primary" disabled={!sel.size} onClick={() => onPick([...sel])}>Link {sel.size || ''} item(s)</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function ActivityActions({ a, onChange }: { a: Row; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card title="Remedial actions" actions={<button onClick={() => setAdding(true)}>+ New action</button>}>
      <DataTable cols={ACTION_COLS} rows={a.actions} onRowClick={(x) => navigate(`#/actions/${x.id}`)} empty="No actions linked to this activity" />
      <p className="muted small">An open Critical action turns this activity red at the <strong>next</strong> Recalculate. Closing it clears that effect at the following Recalculate.</p>
      {adding && (
        <ActionModal
          context={{ activity_id: a.id, site_id: a.site_id, room_id: a.location_level === 'room' ? a.room_id : null, owner_user_id: a.owner_user_id }}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); onChange(); }}
        />
      )}
    </Card>
  );
}

/** Last done + interval -> calculated next due, with an explicit, reasoned override. */
function ScheduleFields({ f, setF, typeInterval }: { f: Row; setF: (f: Row) => void; typeInterval: number | null }) {
  const interval = f.interval_months === '' || f.interval_months === null ? typeInterval : Number(f.interval_months);
  const calculated = f.last_done_on && interval ? addMonths(f.last_done_on, interval) : null;
  const u = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="schedule-box">
      <div className="grid2">
        <Field label="Last inspection / check date"><input aria-label="Last done" type="date" value={f.last_done_on} onChange={u('last_done_on')} /></Field>
        <Field label="Interval (months)" hint={`Blank = type default (${typeInterval ?? 'none'})`}>
          <input aria-label="Interval months" type="number" min={1} value={f.interval_months} onChange={u('interval_months')} />
        </Field>
      </div>
      <div className={`calc-due ${f.next_due_override ? 'superseded' : ''}`} data-testid="calculated-next-due">
        Calculated next due: <strong>{calculated ? fmtDate(calculated) : '—'}</strong>
        <span className="muted small"> {calculated ? `(${fmtDate(f.last_done_on)} + ${interval} months)` : interval ? '(enter the last inspection date)' : '(no interval set)'}</span>
      </div>
      <label className="inline">
        <input type="checkbox" aria-label="Override next due" checked={!!f.next_due_override}
          onChange={(e) => setF({ ...f, next_due_override: e.target.checked, next_due_on: e.target.checked ? (f.next_due_on || calculated || '') : '' })} />
        Override the calculated next-due date
      </label>
      {f.next_due_override && (
        <div className="grid2 override-fields">
          <Field label="Override next due"><input aria-label="Next due" type="date" value={f.next_due_on} onChange={u('next_due_on')} /></Field>
          <Field label="Reason for override (required)"><input aria-label="Override reason" value={f.next_due_override_reason} onChange={u('next_due_override_reason')} placeholder="e.g. Contractor booked earlier" /></Field>
        </div>
      )}
    </div>
  );
}

// ---------- create / edit ----------
export function ActivityForm({ id }: { id?: number }) {
  const { data: core } = useLoad<Core>('/api/core');
  const { data: cur } = useLoad<Row>(id ? `/api/activities/${id}` : null);
  const [f, setF] = useState<Row>({
    type_id: '', location_level: 'site', area: '', site: '', room: '', name: '', ref: '', owner_user_id: '',
    last_done_on: '', next_due_on: '', expires_on: '', interval_months: '', applicability: 'required', na_reason: '', notes: '',
    next_due_override: false, next_due_override_reason: '',
  });
  const [equip, setEquip] = useState<Set<number>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!cur) return;
    setF({
      type_id: String(cur.type_id), location_level: cur.location_level, area: String(cur.area_id ?? ''), site: String(cur.site_id ?? ''), room: String(cur.room_id ?? ''),
      name: cur.name, ref: cur.ref, owner_user_id: String(cur.owner_user_id ?? ''), last_done_on: cur.last_done_on ?? '',
      next_due_on: cur.next_due_override ? (cur.next_due_on ?? '') : '',
      expires_on: cur.expires_on ?? '', interval_months: cur.interval_months ?? '', applicability: cur.applicability, na_reason: cur.na_reason, notes: cur.notes,
      next_due_override: !!cur.next_due_override, next_due_override_reason: cur.next_due_override ? cur.next_due_override_reason : '',
    });
  }, [cur]);

  const level = f.location_level as 'area' | 'site' | 'room';
  const locationId = level === 'area' ? f.area : level === 'site' ? f.site : f.room;
  const candidates = useLoad<Row[]>(!id && locationId ? `/api/equipment?level=${level}&location_id=${locationId}` : null, [level, locationId]);
  const type = core?.types.find((t) => String(t.id) === String(f.type_id));
  const sites = useMemo(() => (core?.sites ?? []).filter((s) => !f.area || String(s.area_id) === f.area), [core, f.area]);
  const rooms = useMemo(() => (core?.rooms ?? []).filter((r) => !f.site || String(r.site_id) === f.site), [core, f.site]);

  if (!core || (id && !cur)) return <Loading />;
  const u = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setErr(null);
    if (!f.type_id) return setErr('Step 1: choose a Compliance Type.');
    if (!locationId) return setErr(`Step 2: choose the ${level} this activity applies to.`);
    if (f.next_due_override && !f.next_due_on) return setErr('Enter the override next-due date, or untick Override.');
    if (f.next_due_override && !f.next_due_override_reason.trim()) return setErr('Give a reason for overriding the calculated next-due date.');
    setSaving(true);
    try {
      const body = {
        type_id: Number(f.type_id), location_level: level, location_id: Number(locationId), name: f.name, owner_user_id: f.owner_user_id || null,
        last_done_on: f.last_done_on || null, expires_on: f.expires_on || null,
        next_due_override: !!f.next_due_override, next_due_on: f.next_due_override ? f.next_due_on : null,
        next_due_override_reason: f.next_due_override ? f.next_due_override_reason : '',
        interval_months: f.interval_months === '' ? null : Number(f.interval_months), applicability: f.applicability, na_reason: f.na_reason, notes: f.notes,
        ...(id ? {} : { ref: f.ref || undefined, equipment_ids: [...equip] }),
      };
      const saved = id ? await api.put(`/api/activities/${id}`, body) : await api.post('/api/activities', body);
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('entity_kind', 'activity');
        fd.append('entity_id', String(saved.id));
        await api.post('/api/documents', fd);
      }
      navigate(`#/activities/${saved.id}?msg=saved`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page title={id ? `Edit ${cur!.ref}` : 'New Compliance Activity'} crumbs={<a href="#/activities">Compliance Activities</a>}>
      <ErrorBox error={err} />
      <div className="grid2">
        <Card title="1. Compliance type">
          <Field label="Type">
            <select aria-label="Compliance type" value={f.type_id} onChange={(e) => setF({ ...f, type_id: e.target.value })}>
              <option value="">Choose…</option>
              {core.types.filter((t) => t.active || String(t.id) === f.type_id).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
            </select>
          </Field>
          {type && <p className="muted small">Default interval {type.suggested_interval_months ?? '—'} months · warning {type.warning_days} days · {type.evidence_required ? 'verified evidence required' : 'no evidence required'}</p>}
        </Card>
        <Card title="2. Location (choose a level deliberately)">
          <div className="radio-row">
            {(['area', 'site', 'room'] as const).map((l) => (
              <label key={l} className="inline">
                <input type="radio" name="level" checked={level === l} onChange={() => { setF({ ...f, location_level: l }); setEquip(new Set()); }} /> {LEVEL_LABEL[l]}
              </label>
            ))}
          </div>
          <Field label="Area">
            <select aria-label="Location area" value={f.area} onChange={(e) => { setF({ ...f, area: e.target.value, site: '', room: '' }); setEquip(new Set()); }}>
              <option value="">Choose…</option>
              {core.areas.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
          </Field>
          {level !== 'area' && (
            <Field label="Site">
              <select aria-label="Location site" value={f.site} onChange={(e) => {
                const s = core.sites.find((x) => String(x.id) === e.target.value);
                setF({ ...f, site: e.target.value, area: s ? String(s.area_id) : f.area, room: '' });
                setEquip(new Set());
              }}>
                <option value="">Choose…</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
              </select>
            </Field>
          )}
          {level === 'room' && (
            <Field label="Room">
              <select aria-label="Location room" value={f.room} onChange={(e) => { setF({ ...f, room: e.target.value }); setEquip(new Set()); }}>
                <option value="">Choose…</option>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} {r.name}</option>)}
              </select>
            </Field>
          )}
          {id && <p className="muted small">Changing the location may leave linked equipment out of scope; the Linked Equipment tab will flag it.</p>}
        </Card>
        <Card title="3. Name, responsibility & schedule">
          <Field label="Activity name (optional)"><input value={f.name} onChange={u('name')} placeholder="e.g. PAT 2027" /></Field>
          {!id && <Field label="Reference (optional)" hint="Leave blank to auto-number PH-C###"><input value={f.ref} onChange={u('ref')} /></Field>}
          <Field label="Responsible person">
            <select aria-label="Responsible person" value={f.owner_user_id} onChange={u('owner_user_id')}>
              <option value="">— none —</option>
              {core.users.filter((x) => x.active || String(x.id) === f.owner_user_id).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.role_label})</option>)}
            </select>
          </Field>
          <ScheduleFields f={f} setF={setF} typeInterval={type?.suggested_interval_months ?? null} />
          <Field label="Certificate / contract expiry (optional)" hint="Only if something expires independently of the schedule; the earlier date wins.">
            <input aria-label="Expires" type="date" value={f.expires_on} onChange={u('expires_on')} />
          </Field>
          <Field label="Applicability">
            <select value={f.applicability} onChange={u('applicability')}>
              <option value="required">Required</option>
              <option value="not_applicable">Not applicable</option>
              <option value="unknown">Unknown</option>
            </select>
          </Field>
          {f.applicability === 'not_applicable' && <Field label="Reason not applicable"><input value={f.na_reason} onChange={u('na_reason')} /></Field>}
          <Field label="Notes"><textarea value={f.notes} onChange={u('notes')} rows={2} /></Field>
        </Card>
        {!id && (
          <Card title="4–5. Equipment & documents (optional)">
            {!locationId && <p className="muted">Choose a location to see equipment in scope.</p>}
            {locationId && candidates.data && candidates.data.length === 0 && <p className="muted">No equipment in this {level}. Location-wide activities don't need equipment.</p>}
            <div className="pick-list short">
              {(candidates.data ?? []).map((e) => (
                <label key={e.id} className="pick-row">
                  <input type="checkbox" checked={equip.has(e.id)} onChange={(ev) => {
                    const n = new Set(equip);
                    ev.target.checked ? n.add(e.id) : n.delete(e.id);
                    setEquip(n);
                  }} />
                  <strong>{e.asset_code}</strong> {e.description} <span className="muted small">{e.room_code} {e.room_name}</span>
                </label>
              ))}
            </div>
            <Field label="Upload evidence document" hint="Stored once in the central library and linked to this activity. Not verified until you tick it.">
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
          </Card>
        )}
      </div>
      <div className="form-actions">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save activity'}</button>
        <a className="btn" href={id ? `#/activities/${id}` : '#/activities'}>Cancel</a>
      </div>
    </Page>
  );
}
