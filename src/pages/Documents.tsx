import { useRef, useState } from 'react';
import { api, type Row } from '../api';
import { Card, DataTable, ErrorBox, Field, Loading, Modal, Page } from '../components';
import { fmtDate, useLoad } from '../util';

export function DocumentsLibrary() {
  const { data: docs, error, reload } = useLoad<Row[]>('/api/documents');
  const [q, setQ] = useState('');
  const [verified, setVerified] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (error) return <ErrorBox error={error} />;
  if (!docs) return <Loading />;

  const upload = async (file: File) => {
    setErr(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const d = await api.post('/api/documents', fd);
      setMsg(d.reused ? `Identical file already stored as DOC-${d.id} "${d.display_name}" — no duplicate created.` : `Uploaded DOC-${d.id}. Link it to records and tick Reviewed/Verified when checked.`);
      reload();
      setOpen(d.id);
    } catch (e: any) {
      setErr(e.message);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const ql = q.toLowerCase();
  const rows = docs.filter((d) =>
    (!verified || String(d.verified_by_operator) === verified) &&
    (!ql || `DOC-${d.id} ${d.display_name} ${d.original_filename} ${d.links.map((l: Row) => l.label).join(' ')}`.toLowerCase().includes(ql)));
  const current = docs.find((d) => d.id === open);
  return (
    <Page
      title="Document Library"
      actions={
        <>
          <input ref={fileRef} type="file" hidden data-testid="library-upload" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <button className="btn-primary" onClick={() => fileRef.current?.click()}>Upload document</button>
        </>
      }
    >
      <p className="muted small">Each file is stored once in local private storage and linked to any number of records. Uploading is not verification.</p>
      <ErrorBox error={err} />
      {msg && <div className="note">{msg}</div>}
      <div className="filters">
        <input type="search" placeholder="Search title, file, linked record…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Verified" value={verified} onChange={(e) => setVerified(e.target.value)}>
          <option value="">Verified & unverified</option>
          <option value="1">Verified</option>
          <option value="0">Not verified</option>
        </select>
      </div>
      <Card>
        <DataTable
          rows={rows}
          onRowClick={(d) => setOpen(d.id)}
          cols={[
            { key: 'id', label: 'Doc ID', render: (d) => `DOC-${d.id}` },
            { key: 'display_name', label: 'Title' },
            { key: 'mime_type', label: 'Type', render: (d) => d.original_filename.split('.').pop()?.toUpperCase() },
            { key: 'uploaded_at', label: 'Uploaded', render: (d) => fmtDate(d.uploaded_at) },
            { key: 'issued_on', label: 'Issued', render: (d) => fmtDate(d.issued_on) },
            { key: 'valid_until', label: 'Valid until', render: (d) => fmtDate(d.valid_until) },
            { key: 'verified_by_operator', label: 'Reviewed/Verified', render: (d) => (d.verified_by_operator ? <span className="ok">✔ Verified</span> : <span className="warn">Not verified</span>) },
            { key: 'links', label: 'Linked records', sort: (d) => d.links.length, render: (d) => <span title={d.links.map((l: Row) => l.label).join('\n')}>{d.links.length ? d.links.map((l: Row) => l.label).slice(0, 2).join('; ') + (d.links.length > 2 ? ` +${d.links.length - 2}` : '') : <span className="muted">Unlinked</span>}</span> },
            { key: 'open', label: '', render: (d) => <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a> },
          ]}
        />
      </Card>
      {current && <DocumentModal doc={current} onClose={() => setOpen(null)} onChange={reload} />}
    </Page>
  );
}

function DocumentModal({ doc, onClose, onChange }: { doc: Row; onClose: () => void; onChange: () => void }) {
  const { data: linkables } = useLoad<Row[]>('/api/linkables');
  const [f, setF] = useState({ display_name: doc.display_name, issued_on: doc.issued_on ?? '', valid_until: doc.valid_until ?? '', notes: doc.notes ?? '', verified_by_operator: !!doc.verified_by_operator });
  const [target, setTarget] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const linked = new Set(doc.links.map((l: Row) => `${l.entity_kind}:${l.entity_id}`));
  const options = (linkables ?? []).filter((l) => !linked.has(`${l.kind}:${l.id}`) && `${l.kind} ${l.label}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={`DOC-${doc.id} · ${doc.display_name}`} onClose={onClose}>
      <ErrorBox error={err} />
      <p className="muted small">{doc.original_filename} · {(doc.size_bytes / 1024).toFixed(1)} KB · sha256 {doc.sha256.slice(0, 12)}… · <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer">Open</a> · <a href={`/api/documents/${doc.id}/file?download=1`}>Download</a></p>
      <Field label="Title"><input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="Issued on"><input type="date" value={f.issued_on} onChange={(e) => setF({ ...f, issued_on: e.target.value })} /></Field>
        <Field label="Valid until"><input type="date" value={f.valid_until} onChange={(e) => setF({ ...f, valid_until: e.target.value })} /></Field>
      </div>
      <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <label className="inline"><input type="checkbox" checked={f.verified_by_operator} onChange={(e) => setF({ ...f, verified_by_operator: e.target.checked })} /> Reviewed / Verified by operator</label>
      <div className="form-actions">
        <button className="btn-primary" onClick={() => run(() => api.put(`/api/documents/${doc.id}`, { ...f, issued_on: f.issued_on || null, valid_until: f.valid_until || null }))}>Save details</button>
        {doc.links.length === 0 && <button onClick={() => run(async () => { await api.del(`/api/documents/${doc.id}`); onClose(); })}>Delete document</button>}
      </div>
      <h3>Linked records ({doc.links.length})</h3>
      <ul className="link-list">
        {doc.links.map((l: Row) => (
          <li key={l.id}>
            <span className="tag">{l.entity_kind === 'action' ? 'remedial' : l.entity_kind}</span> {l.href ? <a href={l.href} onClick={onClose}>{l.label}</a> : l.label} <span className="muted small">({l.link_role})</span>{' '}
            <button className="btn-ghost small" onClick={() => run(() => api.del(`/api/document-links/${l.id}`))}>Unlink</button>
          </li>
        ))}
        {!doc.links.length && <li className="muted">Not linked to anything yet.</li>}
      </ul>
      <div className="filters">
        <input placeholder="Find a record to link…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Link target" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose record…</option>
          {options.slice(0, 300).map((l) => <option key={`${l.kind}:${l.id}`} value={`${l.kind}:${l.id}`}>[{l.kind === 'action' ? 'remedial' : l.kind}] {l.label}</option>)}
        </select>
        <button disabled={!target} onClick={() => run(async () => {
          const [kind, id] = target.split(':');
          await api.post(`/api/documents/${doc.id}/links`, { entity_kind: kind, entity_id: Number(id) });
          setTarget('');
        })}>Link</button>
      </div>
    </Modal>
  );
}
