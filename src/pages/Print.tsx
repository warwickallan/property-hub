import type { Row } from '../api';
import { ErrorBox, Loading } from '../components';
import { fmtDate, fmtDateTime, STATUS_LABEL, useLoad } from '../util';

const ORDER: Record<string, number> = { red: 0, amber: 1, grey: 2, green: 3, na: 4 };

/** Clean printable Site compliance front sheet (no app chrome). */
export function SiteFrontSheetPrint({ id }: { id: number }) {
  const { data: d, error } = useLoad<Row>(`/api/locations/site/${id}`);
  const { data: status } = useLoad<Row>('/api/status');
  const { data: direct } = useLoad<Row[]>(`/api/documents?entity_kind=site&entity_id=${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!d || !status || !direct) return <Loading />;
  const area = d.breadcrumb[0];
  const acts: Row[] = [...d.activities, ...d.inherited].sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || String(a.snap_due_on ?? a.next_due_on ?? '9').localeCompare(String(b.snap_due_on ?? b.next_due_on ?? '9')));
  const count = (s: string | null) => acts.filter((a) => (s ? a.status === s : !a.status)).length;
  const openActions = d.actions.filter((a: Row) => a.state !== 'Done');
  const docs = new Map<number, Row>();
  for (const x of direct) docs.set(x.id, { ...x, via: { label: 'This site (direct)' } });
  for (const x of d.relatedDocuments) if (!docs.has(x.id)) docs.set(x.id, x);
  return (
    <div className="sheet">
      <div className="no-print sheet-tools">
        <button className="btn-primary" onClick={() => window.print()}>Print</button>
        <a className="btn" href={`#/sites/${id}`}>Back to site</a>
      </div>
      <header className="sheet-head">
        <div>
          <div className="sheet-kicker">Property Hub · Site compliance front sheet</div>
          <h1>{d.entity.code} {d.entity.name}</h1>
          <div>Area: {area.code} {area.name}</div>
        </div>
        <div className="sheet-meta">
          <div>Printed {fmtDateTime(new Date().toISOString())}</div>
          <div>Status as at last Recalculate: <strong>{status.lastRun ? fmtDateTime(status.lastRun.createdAt) : 'never calculated'}</strong></div>
          {status.pending && <div className="sheet-warn">Changes saved since then are not reflected — recalculate before relying on this sheet.</div>}
        </div>
      </header>

      <section className="sheet-summary">
        {(['red', 'amber', 'grey', 'green', 'na'] as const).map((s) => (
          <div key={s} className={`sheet-box sb-${s}`}><strong>{count(s)}</strong> {STATUS_LABEL[s]}</div>
        ))}
        {count(null) > 0 && <div className="sheet-box"><strong>{count(null)}</strong> Not yet calculated</div>}
        <div className="sheet-box"><strong>{openActions.length}</strong> Open actions</div>
      </section>

      <h2>Compliance activities ({acts.length})</h2>
      <table className="sheet-table">
        <thead><tr><th>Ref</th><th>Type</th><th>Scope</th><th>Last done</th><th>Next due</th><th>Status</th><th>Reason</th><th>Evidence</th><th>Responsible</th></tr></thead>
        <tbody>
          {acts.map((a) => (
            <tr key={a.id}>
              <td className="nowrap">{a.ref}</td>
              <td>{a.type_code}</td>
              <td>{a.location_level === 'area' ? 'Area-wide' : a.location_level === 'room' ? `${a.room_code} ${a.room_name}` : 'Whole site'}</td>
              <td className="nowrap">{fmtDate(a.last_done_on)}</td>
              <td className="nowrap">{fmtDate(a.snap_due_on ?? a.next_due_on)}</td>
              <td className={`nowrap st-${a.status ?? 'none'}`}>{a.status ? STATUS_LABEL[a.status] : 'Not calculated'}</td>
              <td>{a.status_reason ?? ''}</td>
              <td>{a.verified_doc_count ? 'Verified' : a.doc_count ? 'Unverified' : a.evidence_required ? 'Missing' : '—'}</td>
              <td>{a.owner_name ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Open remedial actions ({openActions.length})</h2>
      {openActions.length ? (
        <table className="sheet-table">
          <thead><tr><th>Ref</th><th>Action</th><th>Priority</th><th>Status</th><th>Due</th><th>Owner</th><th>Activity</th><th>Source</th></tr></thead>
          <tbody>
            {openActions.map((x: Row) => (
              <tr key={x.id}>
                <td className="nowrap">{x.ref}</td><td>{x.title}</td><td>{x.priority}</td><td>{x.state}{x.overdue ? ' (overdue)' : ''}</td>
                <td className="nowrap">{fmtDate(x.due_on)}</td><td>{x.owner_name ?? '—'}</td><td>{x.activity_ref ?? '—'}</td><td>{x.inspection_ref ? `${x.inspection_ref} ${x.question_code ?? ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>None.</p>}

      <h2>Recent routine inspections</h2>
      {d.inspections.length ? (
        <table className="sheet-table">
          <thead><tr><th>Ref</th><th>Date</th><th>Scope</th><th>Inspector</th><th>Status</th><th>Answered</th><th>Issues</th></tr></thead>
          <tbody>
            {d.inspections.slice(0, 5).map((r: Row) => (
              <tr key={r.id}>
                <td className="nowrap">{r.ref}</td><td className="nowrap">{fmtDate(r.inspected_on)}</td><td>{r.room_code ? `${r.room_code} ${r.room_name}` : 'Whole site'}</td>
                <td>{r.inspector}</td><td>{r.state === 'complete' ? 'Completed' : 'Draft'}</td><td>{r.answered}/{r.question_count}</td><td>{r.issues}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>None recorded.</p>}

      <h2>Documents ({docs.size})</h2>
      {docs.size ? (
        <table className="sheet-table">
          <thead><tr><th>Document</th><th>Linked via</th><th>Valid until</th><th>Verified</th></tr></thead>
          <tbody>
            {[...docs.values()].map((x) => (
              <tr key={x.id}><td>DOC-{x.id} {x.display_name}</td><td>{x.via.label}</td><td className="nowrap">{fmtDate(x.valid_until)}</td><td>{x.verified_by_operator ? 'Yes' : 'No'}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <p>None linked.</p>}
      <footer className="sheet-foot">Routine inspections are visual observations and are not statutory certificates. Fictional demo data. Generated locally by Property Hub.</footer>
    </div>
  );
}
