// Admin › Checklists: templates per Compliance Type, editable questions, reorder, archive, duplicate.
import { useEffect, useState } from 'react';
import { api, type Row } from '../api';
import { Card, DataTable, ErrorBox, Field, Loading, Modal, Page } from '../components';
import { fmtStamp, navigate, useLoad } from '../util';

export function ChecklistsAdmin() {
  const { data, error, reload } = useLoad<Row[]>('/api/checklists');
  const { data: types } = useLoad<Row[]>('/api/types');
  const [type, setType] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data || !types) return <Loading />;
  const rows = data.filter((c) => (!type || String(c.compliance_type_id) === type) && (showArchived || c.active));
  return (
    <Page title="Checklists" crumbs="Admin / Setup" actions={<button className="btn-primary" onClick={() => setAdding(true)}>+ New checklist</button>}>
      <p className="muted small">Each checklist belongs to a Compliance Type. A Compliance Activity picks one; its visits keep a snapshot of the questions and version used, so editing a checklist never changes past inspections.</p>
      <div className="filters">
        <select aria-label="Checklist type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All compliance types</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
        </select>
        <label className="inline small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
      </div>
      <Card>
        <DataTable
          rows={rows}
          onRowClick={(c) => navigate(`#/admin/checklists/${c.id}`)}
          initialSort={{ key: 'type_code', dir: 1 }}
          cols={[
            { key: 'code', label: 'Code', render: (c) => <strong>{c.code}</strong> },
            { key: 'name', label: 'Checklist' },
            { key: 'type_code', label: 'Compliance type', render: (c) => `${c.type_code} — ${c.type_name}` },
            { key: 'item_count', label: 'Questions', className: 'num' },
            { key: 'mandatory_count', label: 'Mandatory', className: 'num' },
            { key: 'version', label: 'Version', className: 'num' },
            { key: 'activity_count', label: 'Activities', className: 'num' },
            { key: 'visit_count', label: 'Visits', className: 'num' },
            { key: 'active', label: 'Status', render: (c) => (c.active ? 'Active' : 'Archived') },
          ]}
        />
      </Card>
      {adding && <NewChecklistModal types={types} onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); reload(); navigate(`#/admin/checklists/${c.id}`); }} />}
    </Page>
  );
}

function NewChecklistModal({ types, onClose, onSaved }: { types: Row[]; onClose: () => void; onSaved: (c: Row) => void }) {
  const [f, setF] = useState({ name: '', compliance_type_id: '', description: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="New checklist" onClose={onClose}>
      <ErrorBox error={err} />
      <Field label="Name"><input aria-label="Checklist name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Compliance type">
        <select aria-label="New checklist type" value={f.compliance_type_id} onChange={(e) => setF({ ...f, compliance_type_id: e.target.value })}>
          <option value="">Choose…</option>
          {types.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
        </select>
      </Field>
      <Field label="Description"><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="form-actions">
        <button className="btn-primary" onClick={async () => {
          setErr(null);
          try { onSaved(await api.post('/api/checklists', f)); } catch (e: any) { setErr(e.message); }
        }}>Create checklist</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

export function ChecklistEditor({ id }: { id: number }) {
  const { data: c, error, setData } = useLoad<Row>(`/api/checklists/${id}`);
  const { data: types } = useLoad<Row[]>('/api/types');
  const [head, setHead] = useState<Row | null>(null);
  const [nq, setNq] = useState({ question: '', section: '', mandatory: true });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    if (c) setHead({ name: c.name, compliance_type_id: String(c.compliance_type_id), description: c.description });
  }, [c?.id, c?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorBox error={error} />;
  if (!c || !types || !head) return <Loading />;
  const run = async (fn: () => Promise<Row>, note: string) => {
    setErr(null);
    setMsg(null);
    try {
      setData(await fn());
      setMsg(note);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const active = c.items.filter((i: Row) => i.active);
  const move = (idx: number, dir: -1 | 1) => {
    const ids = active.map((i: Row) => i.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    run(() => api.post(`/api/checklists/${id}/reorder`, { item_ids: ids }), 'Order saved.');
  };
  const items = c.items.filter((i: Row) => showArchived || i.active);
  return (
    <Page
      crumbs={<><a href="#/admin/checklists">Checklists</a></>}
      title={<>{c.code} · {c.name} <span className="muted small">v{c.version}</span> {!c.active && <span className="chip chip-none">Archived</span>}</>}
      actions={
        <>
          <button onClick={() => run(async () => { const d = await api.post(`/api/checklists/${id}/duplicate`, {}); navigate(`#/admin/checklists/${d.id}`); return d; }, 'Duplicated.')}>Duplicate</button>
          <button onClick={() => run(() => api.put(`/api/checklists/${id}`, { active: !c.active }), c.active ? 'Checklist archived: new activities cannot select it.' : 'Checklist re-activated.')}>{c.active ? 'Archive' : 'Activate'}</button>
        </>
      }
    >
      <ErrorBox error={err} />
      {msg && <div className="note ok-note">{msg}</div>}
      <p className="muted small">Used by {c.activity_count} activit{c.activity_count === 1 ? 'y' : 'ies'} and {c.visit_count} visit(s). Edits create version {c.version + 1}; visits already started keep their own snapshot. Last changed {fmtStamp(c.updated_at)}.</p>
      <div className="grid2">
        <Card title="Checklist details">
          <Field label="Name"><input aria-label="Checklist name" value={head.name} onChange={(e) => setHead({ ...head, name: e.target.value })} /></Field>
          <Field label="Compliance type">
            <select aria-label="Checklist compliance type" value={head.compliance_type_id} onChange={(e) => setHead({ ...head, compliance_type_id: e.target.value })}>
              {types.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
            </select>
          </Field>
          <Field label="Description"><textarea rows={2} value={head.description} onChange={(e) => setHead({ ...head, description: e.target.value })} /></Field>
          <div className="form-actions"><button className="btn-primary" onClick={() => run(() => api.put(`/api/checklists/${id}`, head), 'Saved.')}>Save details</button></div>
        </Card>
        <Card title="Add a question">
          <Field label="Question"><textarea aria-label="New question" rows={2} value={nq.question} onChange={(e) => setNq({ ...nq, question: e.target.value })} /></Field>
          <Field label="Section (optional)"><input aria-label="New question section" value={nq.section} onChange={(e) => setNq({ ...nq, section: e.target.value })} /></Field>
          <label className="inline"><input type="checkbox" checked={nq.mandatory} onChange={(e) => setNq({ ...nq, mandatory: e.target.checked })} /> Mandatory</label>
          <p className="muted small">Every question is answered Pass / Issue / Not applicable / Not checked, with optional notes; evidence can be linked to the visit.</p>
          <div className="form-actions"><button className="btn-primary" disabled={!nq.question.trim()} onClick={async () => {
            await run(() => api.post(`/api/checklists/${id}/items`, nq), 'Question added.');
            setNq({ question: '', section: nq.section, mandatory: true });
          }}>Add question</button></div>
        </Card>
      </div>
      <Card title={`Questions (${active.length} active)`} actions={<label className="inline small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>}>
        <table className="table compact">
          <thead><tr><th>#</th><th>Code</th><th>Section</th><th>Question</th><th>Mandatory</th><th>Order</th><th></th></tr></thead>
          <tbody>
            {items.map((i: Row) => {
              const idx = active.findIndex((x: Row) => x.id === i.id);
              return (
                <tr key={i.id} className={i.active ? '' : 'archived-row'}>
                  <td>{i.active ? idx + 1 : '—'}</td>
                  <td className="nowrap">{i.code}</td>
                  <td>{i.section}</td>
                  <td>{i.question}</td>
                  <td>
                    <input type="checkbox" aria-label={`Mandatory ${i.code}`} checked={!!i.mandatory} disabled={!i.active}
                      onChange={(e) => run(() => api.put(`/api/checklist-items/${i.id}`, { mandatory: e.target.checked }), `${i.code} is now ${e.target.checked ? 'mandatory' : 'optional'}.`)} />
                  </td>
                  <td className="nowrap">
                    {i.active && <>
                      <button className="btn-ghost small" aria-label={`Move ${i.code} up`} disabled={idx === 0} onClick={() => move(idx, -1)}>↑</button>
                      <button className="btn-ghost small" aria-label={`Move ${i.code} down`} disabled={idx === active.length - 1} onClick={() => move(idx, 1)}>↓</button>
                    </>}
                  </td>
                  <td className="nowrap">
                    {i.active && <button className="btn-ghost small" onClick={() => setEditing(i)}>Edit</button>}
                    <button className="btn-ghost small" onClick={() => run(() => api.put(`/api/checklist-items/${i.id}`, { active: !i.active }), i.active ? `${i.code} archived.` : `${i.code} restored.`)}>{i.active ? 'Archive' : 'Restore'}</button>
                  </td>
                </tr>
              );
            })}
            {!items.length && <tr><td colSpan={7} className="muted center">No questions yet</td></tr>}
          </tbody>
        </table>
      </Card>
      {editing && (
        <Modal title={`Edit ${editing.code}`} onClose={() => setEditing(null)}>
          <Field label="Question"><textarea aria-label="Edit question" rows={3} value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} /></Field>
          <Field label="Section"><input value={editing.section} onChange={(e) => setEditing({ ...editing, section: e.target.value })} /></Field>
          <div className="form-actions">
            <button className="btn-primary" onClick={async () => { await run(() => api.put(`/api/checklist-items/${editing.id}`, { question: editing.question, section: editing.section }), `${editing.code} updated.`); setEditing(null); }}>Save question</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
