// Minimal RFC 4180 CSV writer with spreadsheet formula-injection protection.
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Cells beginning with = + - @ (or tab/CR) are executed as formulas by Excel; neutralise them.
  // Plain negative numbers are left alone.
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], cols: CsvColumn<T>[]): string {
  const lines = [cols.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c.value(r))).join(','));
  // BOM so Excel opens UTF-8 correctly; CRLF line endings per RFC 4180.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function sendCsv(res: import('express').Response, filename: string, body: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}
