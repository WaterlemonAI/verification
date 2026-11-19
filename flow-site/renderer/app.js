import { renderSchemaProgress, renderSchemaStage } from './schema-view.js';
const state = { applicationId: sessionStorage.getItem('flo_application_id') || '',
  csrf: sessionStorage.getItem('flo_csrf') || '', application: null, step: 0, meetingSlots: [] };
const $ = (id) => document.getElementById(id);
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function showIntro() {
  const app = state.application;
  const term = app.presentation.stages.flatMap((stage) => stage.declarations).find((entry) => entry.id === 'sample_terms');
  if (!term || app.declarations?.sample_terms) return;
  const list = $('intro-documents'); list.replaceChildren();
  for (const doc of app.presentation.stages.flatMap((stage) => stage.documents).filter((entry) => entry.required)) {
    const item = document.createElement('li'); item.textContent = `${doc.label}${doc.show_if ? ' (if applicable)' : ''}`; list.append(item);
  }
  $('intro-terms').textContent = app.presentation.stages[0]?.description || term.label;
  const dialog = $('intro'); dialog.addEventListener('cancel', (event) => event.preventDefault(), { once: true });
  dialog.showModal();
}
$('intro-continue').addEventListener('click', async () => {
  if (!$('intro-agree').checked) { notice('Agree to the sample terms to continue.'); return; }
  $('intro-continue').disabled = true;
  try { await api('declarations', 'POST', { sample_terms: true });
    state.application.declarations.sample_terms = true; $('intro').close(); notice(''); render();
  } catch (error) { notice(error.message); } finally { $('intro-continue').disabled = false; }
});
async function api(route, method = 'GET', data) {
  const response = await fetch(`/flo/api/${route}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-flo-application-id': state.applicationId,
      ...(method === 'GET' ? {} : { 'x-flo-csrf': state.csrf }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.gaps?.length
    ? result.gaps.find((gap) => gap.includes('is expired, please update recent')) || `Complete: ${result.gaps.join(', ')}`
    : result.error || 'Request failed');
  return result;
}
function render() {
  const app = state.application; const schema = app.presentation;
  $('title').textContent = schema.name; document.title = schema.name;
  $('subtitle').textContent = `${app.brand_name || 'Your organisation'} requested this information for ${schema.name}.`;
  const links = $('links'); links.replaceChildren();
  for (const [title, href] of [['Support', app.support_url], ['Privacy', app.privacy_url]]) {
    if (!href || !/^https:\/\//i.test(href)) continue;
    const anchor = document.createElement('a'); anchor.textContent = title; anchor.href = href;
    anchor.rel = 'noopener noreferrer'; anchor.referrerPolicy = 'no-referrer'; anchor.target = '_blank'; links.append(anchor);
  }
  if (app.logo_asset_url && /^\/flo\/assets\/[a-z][a-z0-9-]{2,63}\/[0-9a-f-]{36}$/.test(app.logo_asset_url)) {
    $('brand-logo').src = app.logo_asset_url; $('brand-logo').hidden = false;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(schema.tokens?.primary_color || ''))
    document.documentElement.style.setProperty('--brand', schema.tokens.primary_color);
  renderSchemaProgress($('steps'), schema, state.step);
  renderSchemaStage($('form'), { schema, stageIndex: state.step, draft: app.draft,
    documents: app.documents, declarations: app.declarations, onFieldChange: (id, value, dependent) => {
      if (dependent) { app.draft[id] = value; render(); }
    } });
  renderMeeting();
  if (app.document_issues?.length) {
    const issues = document.createElement('section'); issues.className = 'restart';
    for (const issue of app.document_issues) { const line = document.createElement('p');
      line.textContent = issue.message; issues.append(line); }
    $('form').prepend(issues);
  }
  $('back').hidden = state.step === 0; $('next').hidden = state.step === schema.stages.length - 1;
  $('submit').hidden = state.step !== schema.stages.length - 1;
  if (app.restart) { const banner = document.createElement('section'); banner.className = 'restart';
    const heading = document.createElement('strong'); heading.textContent = 'Changes requested';
    const details = document.createElement('p'); details.textContent = app.restart.comments;
    const targets = document.createElement('p'); targets.textContent = [...(app.restart.fields || []), ...(app.restart.documents || [])].join(', ');
    banner.append(heading, details, targets); $('form').prepend(banner); }
}
function renderMeeting() {
  const app = state.application; const rule = app.presentation.meeting?.required_for;
  if (state.step !== 0 || !rule || app.draft?.[rule.field] !== rule.equals) return;
  const section = document.createElement('section'); section.className = 'meeting';
  const heading = document.createElement('h2'); heading.textContent = 'Book a video meeting'; section.append(heading);
  const info = document.createElement('p');
  info.textContent = 'Choose a 30 minute time. Your procurement contact will join and confirm the meeting afterwards.';
  section.append(info);
  if (app.meeting?.status === 'booked') {
    section.append(document.createTextNode(`Booked: ${new Date(app.meeting.starts_at).toLocaleString('en-AE', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' })} Dubai time. `));
    if (app.meeting.meeting_url) { const link = document.createElement('a'); link.href = app.meeting.meeting_url;
      link.textContent = 'Join meeting'; link.target = '_blank'; link.rel = 'noopener noreferrer'; section.append(link); }
    const status = document.createElement('p'); status.textContent = app.meeting.completed_at
      ? 'Procurement confirmed the meeting.' : 'Awaiting procurement confirmation after the call.';
    section.append(status);
    if (app.meeting.delivery_status === 'delivery-incomplete') {
      const warning = document.createElement('p'); warning.textContent = 'One invitation may not have been delivered. Please contact procurement.'; section.append(warning);
    }
  } else {
    const from = document.createElement('input'); from.type = 'date'; from.dataset.meeting = 'true';
    from.setAttribute('aria-label', 'Find appointments starting from');
    from.min = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400_000));
    const find = document.createElement('button'); find.type = 'button'; find.textContent = 'Find available times';
    const select = document.createElement('select'); select.dataset.meeting = 'true';
    select.setAttribute('aria-label', 'Available Dubai meeting times');
    const fill = () => { select.replaceChildren();
      for (const slot of state.meetingSlots) { const option = document.createElement('option'); option.value = slot.starts_at;
        option.textContent = `${slot.date} ${slot.start_time}–${slot.end_time} (Dubai)`; select.append(option); }
      select.hidden = !state.meetingSlots.length; book.hidden = !state.meetingSlots.length;
    };
    const book = document.createElement('button'); book.type = 'button'; book.textContent = 'Book selected time';
    find.addEventListener('click', async () => { find.disabled = true; try {
      const supplierType = $('form').querySelector('[name="supplier_type"]')?.value;
      if (supplierType) { await api('draft', 'POST', { supplier_type: supplierType }); app.draft.supplier_type = supplierType; }
      const result = await api('meeting/availability', 'POST', from.value ? { from_date: from.value } : {});
      if (result.meeting) { app.meeting = result.meeting; render(); return; }
      state.meetingSlots = result.slots || []; fill();
      notice(state.meetingSlots.length ? '' : 'No times found in this date range. Try a later start date.');
    } catch (error) { notice(error.message); } finally { find.disabled = false; } });
    book.addEventListener('click', async () => { book.disabled = true; try {
      const result = await api('meeting/book', 'POST', { starts_at: select.value }); app.meeting = result.meeting;
      state.meetingSlots = []; notice(''); render();
    } catch (error) { notice(error.message); book.disabled = false; } });
    section.append(from, find, select, book); fill();
  }
  $('form').append(section);
}
async function saveStep() {
  const inputs = [...$('form').querySelectorAll('input:not([data-meeting]),select:not([data-meeting]),textarea:not([data-meeting])')]; const draft = {}; const declarations = {};
  for (const input of inputs) {
    if (!input.checkValidity()) { input.reportValidity(); throw new Error(`Check ${input.name}`); }
    if (input.type === 'file' || input.type === 'checkbox') continue;
    draft[input.name] = input.dataset.fieldType === 'people' ? input.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, role, ownership] = line.split('|').map((part) => part.trim());
      if (ownership && (!Number.isFinite(Number(ownership)) || Number(ownership) < 0 || Number(ownership) > 100))
        throw new Error('Ownership percentage must be between 0 and 100.');
      return { name, role, ownership_percentage: ownership ? Number(ownership) : null };
    }) : input.value.trim();
  }
  for (const input of inputs.filter((entry) => entry.type === 'checkbox')) {
    if (!input.checked) throw new Error('Accept the required declaration.');
    declarations[input.name] = true;
  }
  if (Object.keys(draft).length) { await api('draft', 'POST', draft); Object.assign(state.application.draft, draft); }
  if (Object.keys(declarations).length) { await api('declarations', 'POST', declarations); Object.assign(state.application.declarations, declarations); }
  for (const input of inputs.filter((entry) => entry.type === 'file' && entry.files?.length)) {
    const file = input.files[0]; if (file.size > 6 * 1024 * 1024) throw new Error('Each file must be under 6 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const mime = file.type === 'application/pdf' ? 'application/pdf' : file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const result = await api('documents', 'POST', { type: input.name, mime_type: mime, content_base64: btoa(binary) });
    state.application.documents.push(result.document);
  }
}
function prefillFromDocuments() {
  const app = state.application;
  const extracted = (type) => app.documents.findLast((doc) => doc.type === type && doc.extraction_state === 'completed')?.extraction_result?.data || {};
  const licence = extracted('trade_licence');
  const incorporation = extracted('incorporation_record');
  const identity = extracted('natural_identity');
  const bank = extracted('bank_letter');
  const usable = (value) => typeof value === 'string' && value.trim()
    && !['not found', 'not readable', 'n/a'].includes(value.trim().toLowerCase()) ? value.trim() : '';
  const suggestions = {
    business_name: usable(licence.company_name_english) || usable(incorporation.company_name) || usable(identity.full_name_english),
    licence_number: usable(licence.license_number),
    registration_country: usable(incorporation.registration_country)
      || (app.draft.registration_jurisdiction === 'United Arab Emirates' ? 'United Arab Emirates' : ''),
    licence_expiry: usable(licence.expiry_date),
    natural_id_expiry: usable(identity.expiry_date),
    representative_id_expiry: usable(extracted('identity_document').expiry_date),
    bank_country: usable(bank.bank_country), iban: usable(bank.iban)
  };
  for (const [field, value] of Object.entries(suggestions)) if (value && !app.draft[field]) app.draft[field] = value;
  if (!app.draft.bank_outside_registration && suggestions.bank_country && suggestions.registration_country) {
    const normal = (value) => { const raw = value.toLowerCase().replace(/[^a-z]/g, '');
      return ['ae', 'uae', 'unitedarabemirates'].includes(raw) ? 'ae' : raw; };
    app.draft.bank_outside_registration = normal(suggestions.bank_country) === normal(suggestions.registration_country) ? 'No' : 'Yes';
  }
}
async function extractDocuments({ prefill = false } = {}) {
  if (!state.application.documents.length
    || !state.application.documents.some((doc) => ['not_run', 'queued'].includes(doc.extraction_state))) return;
  await api('extract', 'POST', {});
  // Dedicated OCR jobs may take longer than the document step. Keep the form usable.
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    state.application = (await api('application')).application;
    if (state.application.preview_ready_at) { if (prefill) prefillFromDocuments(); return; }
  }
  notice('Document extraction is continuing. Please confirm any details that are still blank.');
}
async function action(operation) { notice(''); const buttons = [$('back'), $('next'), $('submit')]; buttons.forEach((button) => button.disabled = true);
  try { await operation(); } catch (error) { notice(error.message); } finally { buttons.forEach((button) => button.disabled = false); } }
$('back').addEventListener('click', () => { state.step--; render(); window.scrollTo(0, 0); });
$('next').addEventListener('click', () => action(async () => { await saveStep();
  const rule = state.application.presentation.meeting?.required_for;
  if (state.step === 0 && rule && state.application.draft?.[rule.field] === rule.equals
    && state.application.meeting?.status !== 'booked') throw new Error('Book a video meeting before continuing.');
  try { await extractDocuments({ prefill: true }); } catch { notice('Document extraction is unavailable. Please retry after it is restored.'); }
  const blockingDocument = state.application.document_issues?.find((issue) => issue.code !== 'ocr_incomplete');
  if (blockingDocument) throw new Error(blockingDocument.message);
  state.step++; render(); window.scrollTo(0, 0); }));
$('submit').addEventListener('click', () => action(async () => { await saveStep();
  await extractDocuments();
  const blockingDocument = state.application.document_issues?.[0];
  if (blockingDocument) throw new Error(blockingDocument.message);
  const result = await api('submit', 'POST', {});
  $('form').hidden = true; $('steps').hidden = true; document.querySelector('.actions').hidden = true;
  $('receipt').hidden = false; $('reference').textContent = result.application_id; }));
async function start() {
  try {
    const token = /^\/f\/([A-Za-z0-9_-]{40,100})$/.exec(location.pathname)?.[1];
    if (token) { const session = await api('session', 'POST', { token });
      state.applicationId = session.application_id; state.csrf = session.csrf_token;
      sessionStorage.setItem('flo_application_id', state.applicationId); sessionStorage.setItem('flo_csrf', state.csrf);
      history.replaceState(null, '', '/flo'); }
    if (!state.applicationId) throw new Error('Open the link provided by your buyer.');
    state.application = (await api('application')).application;
    if (!['in_progress', 'restarted'].includes(state.application.status)) { $('receipt').hidden = false;
      $('reference').textContent = state.application.application_id; $('form').hidden = true; document.querySelector('.actions').hidden = true; return; }
    state.application.draft ||= {}; state.application.documents ||= []; state.application.declarations ||= {};
    render(); showIntro();
  } catch (error) { notice(error.message); $('form').hidden = true; document.querySelector('.actions').hidden = true; }
}
start();
