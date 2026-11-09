const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

export function renderFloReportHtml(model) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(model.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 20px;color:#182b43}h1{font-size:28px}h2{border-top:1px solid #ccd7e3;padding-top:18px;margin-top:30px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f9;padding:12px}li{margin:8px 0}@media print{body{margin:0}h2{break-after:avoid}li{break-inside:avoid}}</style></head><body><h1>${escape(model.title)}</h1><p>Application ${escape(model.application_id)} · ${escape(model.generated_at)}</p>${model.sections.map((section) => `<section><h2>${escape(section.title)}</h2><ul>${section.lines.map((line) => `<li><pre>${escape(line)}</pre></li>`).join('')}</ul></section>`).join('')}</body></html>`;
}
