export const ADVANCE_TITLE_URL_FILTER_VERSION = 'advance-title-url-v1';

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function names(request) {
  const values = [request.name, ...(request.aliases || []),
    ...Object.values(request.transliterations || {}).flat()];
  if (request.entity_type === 'business') {
    let short = String(request.name || '').trim();
    const suffix = /\b(?:group|holdings?|trading|pty|llc|ltd|limited|plc|inc|gmbh|pjsc|fzco|pte|corporation|company)\.?$/iu;
    while (suffix.test(short)) {
      const next = short.replace(suffix, '').trim();
      if (next.split(/\s+/u).length < 2) break;
      short = next;
    }
    if (short.length >= 5) values.push(short);
  }
  return [...new Set(values.map(normalized).filter((value) => value.length >= 4))];
}

export function advanceTitleUrlCandidate(row, request) {
  let path = '';
  try {
    const url = new URL(row?.url);
    if (['http:', 'https:'].includes(url.protocol)) {
      try { path = decodeURIComponent(url.pathname); }
      catch { path = url.pathname; }
    }
  } catch { /* Invalid URLs cannot establish a direct URL mention. */ }
  const title = ` ${normalized(row?.title)} `;
  const location = ` ${normalized(path)} `;
  for (const name of names(request)) {
    if (title.includes(` ${name} `)) return { selected: true, source: 'title', matched_name: name };
    if (location.includes(` ${name} `)) return { selected: true, source: 'url', matched_name: name };
  }
  return { selected: false, source: 'title_url_no_subject_match', matched_name: '' };
}
advanceTitleUrlCandidate.version = ADVANCE_TITLE_URL_FILTER_VERSION;
