// Customer-facing field reference generated from the published OpenAPI contract.
// Keep field paths in the schema as the source of truth; this view adds only
// presentation and an explicit fallback for source-dependent values.
(async () => {
  const page = location.pathname.replace(/\/$/, '') || '/';
  const ocrId = page.startsWith('/document-extraction/') ? page.split('/').at(-1).replaceAll('-', '_') : null;
  const config = ocrId
    ? { spec: '/document-extraction/openapi.json', responses: [
      ['202 acceptance receipt', 'DocumentOcrAccepted'],
      ['Completed result', `${ocrId}_Result`],
      ...(['uae_trade_license_ocr', 'moa_analysis'].includes(ocrId) ? [['Alternative completed result', `${ocrId}_TaedResult`]] : [])
    ] }
    : {
      '/': { spec: '/openapi.json', responses: [['Verification response', 'Success']] },
      '/iban': { spec: '/openapi.json', responses: [['Verification response', 'IbanVerificationResponse']] },
      '/adverse-media': { spec: '/openapi.json', responses: [['Completed response', 'AdverseMediaResponse'], ['202 queued response', 'AdverseMediaQueuedResponse']] },
      '/merchant-screening': { spec: '/openapi.json', responses: [['Screening response', 'MerchantScreeningResponse']] },
      '/ejari-verification': { spec: '/ejari-verification/openapi.json', responses: [['202 acceptance receipt', 'Receipt'], ['Job status', 'JobStatus'], ['202 pending result', 'PendingResult'], ['Completed result', 'Result']] },
      '/peppol-directory': { spec: '/openapi.json', responses: [['Directory response', 'PeppolGlobalResult']] }
    }[page];
  const article = document.getElementById('responses');
  if (!config || !article) return;

  const title = document.createElement('h3');
  title.textContent = 'All documented response fields';
  const guidance = document.createElement('p');
  guidance.textContent = '“Required” means the field is required by that response variant, not that it contains a positive match. Arrays can contain zero or many results; each [] path describes one returned item. Fields in open objects depend on the underlying source. Review the HTTP status and coverage before interpreting field values.';
  const region = document.createElement('div');
  region.className = 'response-schema';
  region.setAttribute('aria-label', 'Complete documented response field reference');
  const table = document.createElement('div');
  table.className = 'schema-table';
  const head = document.createElement('div');
  head.className = 'schema-head';
  for (const label of ['Field path', 'Type', 'Expectation']) {
    const cell = document.createElement('span'); cell.textContent = label; head.append(cell);
  }
  table.append(head);
  region.append(table);
  const anchor = [...article.querySelectorAll('h3')].find((element) => element.textContent.includes('Status codes'));
  for (const element of [title, guidance, region]) article.insertBefore(element, anchor || null);

  try {
    const response = await fetch(config.spec, { cache: 'no-store' });
    if (!response.ok) throw new Error('OpenAPI contract unavailable');
    const spec = await response.json();
    const rows = new Map();
    const resolve = (schema) => {
      if (!schema?.$ref) return schema || {};
      if (!schema.$ref.startsWith('#/')) return schema;
      const target = schema.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
      return { ...target, ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')) };
    };
    const add = (path, schema, required, variant) => {
      const type = Array.isArray(schema.type) ? schema.type.join(' / ') : schema.type || (schema.const !== undefined ? typeof schema.const : schema.enum ? 'enum' : 'object');
      const isArray = schema.type === 'array' || Array.isArray(schema.type) && schema.type.includes('array');
      const label = path.split('.').at(-1).replace(/\[\]$/, '').replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      let description = schema.description?.trim();
      if (!description) {
        if (isArray) description = `Zero or more ${label} entries; the count and each item depend on the underlying source or selected checks.`;
        else if (schema.additionalProperties === true || typeof schema.additionalProperties === 'object') description = `Source-dependent ${label} details. The object may contain additional fields from the underlying source; inspect the returned keys and coverage.`;
        else if (schema.type === 'object' || schema.properties || schema.oneOf || schema.anyOf) description = `${label} container; expand its child paths below when defined. Its contents depend on the response variant and source.`;
        else description = `Source-dependent ${label} value. Availability and exact meaning depend on the underlying source record.`;
      }
      if (schema.enum) description += ` Expected values: ${schema.enum.map(String).join(', ')}.`;
      if (schema.const !== undefined) description += ` Fixed value: ${String(schema.const)}.`;
      if (isArray) description += ' Multiple results may be returned.';
      description += required ? ' Required in this variant.' : ' Optional or variant-dependent.';
      const key = `${variant}\u0000${path}`;
      rows.set(key, { path, type, description, variant });
    };
    const walk = (node, path, required, variant, depth = 0, seen = new Set()) => {
      if (depth > 12) return;
      const ref = node?.$ref;
      if (ref && seen.has(`${ref}:${path}`)) return;
      const nextSeen = new Set(seen);
      if (ref) nextSeen.add(`${ref}:${path}`);
      const schema = resolve(node);
      if (path) add(path, schema, required, variant);
      for (const option of [...(schema.oneOf || []), ...(schema.anyOf || []), ...(schema.allOf || [])]) {
        walk(option, path, required, variant, depth + 1, nextSeen);
      }
      for (const [name, child] of Object.entries(schema.properties || {})) {
        walk(child, path ? `${path}.${name}` : name, (schema.required || []).includes(name), variant, depth + 1, nextSeen);
      }
      if ((schema.type === 'array' || Array.isArray(schema.type) && schema.type.includes('array')) && schema.items && path) walk(schema.items, `${path}[]`, false, variant, depth + 1, nextSeen);
    };
    for (const [variant, schemaName] of config.responses) {
      const schema = spec.components?.schemas?.[schemaName];
      if (!schema) throw new Error(`Missing ${schemaName} schema`);
      walk(schema, '', true, variant);
    }
    for (const row of rows.values()) {
      const line = document.createElement('div');
      const path = document.createElement('code'); path.textContent = row.path;
      const type = document.createElement('span'); type.textContent = row.type;
      const expectation = document.createElement('span'); expectation.textContent = `${row.variant}: ${row.description}`;
      line.append(path, type, expectation); table.append(line);
    }
  } catch (error) {
    const message = document.createElement('p');
    message.textContent = `The field reference could not load: ${error.message}. Open the linked OpenAPI contract for the response schema.`;
    region.replaceChildren(message);
  }
})();
