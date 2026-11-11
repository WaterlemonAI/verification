const columns = [
  ['date_time', 'UTC time'], ['transaction_id', 'Transaction ID'], ['modules', 'Modules'],
  ['state', 'State'], ['response_code', 'HTTP code'], ['cost', 'Cost'],
  ['refund_amount', 'Refund amount'], ['refund_reason', 'Refund reason'],
  ['key_id', 'Key ID'], ['method', 'Method'], ['path', 'Path']
];
const cell = (value) => {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  const protectedText = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
};
export function usageCsv(rows, { maxRows = 1000 } = {}) {
  if (!Array.isArray(rows) || rows.length > maxRows) throw new Error('usage_export_too_large');
  return '\uFEFF' + [columns.map(([, title]) => cell(title)).join(','),
    ...rows.map((row) => columns.map(([key]) => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
