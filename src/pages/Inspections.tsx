import type { Row } from '../api';
import { Card, Loading, Page } from '../components';
import { useLoad } from '../util';

export function Inspections() {
  const { data } = useLoad<Row[]>('/api/checklist');
  if (!data) return <Loading />;
  const groups = new Map<string, Row[]>();
  for (const q of data) groups.set(q.group_name, [...(groups.get(q.group_name) ?? []), q]);
  return (
    <Page title="Inspections">
      <div className="note">
        <strong>P1 — not yet available.</strong> Routine 30-point site inspections (per Site, optional Room) with stored answers and Issue → Action are the next
        build phase. The question set below is imported verbatim from the template and is already in the database. Routine inspections do not substitute statutory evidence.
      </div>
      {[...groups.entries()].map(([g, qs]) => (
        <Card key={g} title={`${g} (${qs.length})`}>
          <ol className="checklist">
            {qs.map((q) => <li key={q.code} value={q.sort_order}><span className="muted small">{q.code}</span> {q.question}</li>)}
          </ol>
        </Card>
      ))}
    </Page>
  );
}
