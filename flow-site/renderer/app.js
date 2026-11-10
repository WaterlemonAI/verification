import { renderSchemaProgress, renderSchemaStage } from './schema-view.js';
const state = { applicationId: sessionStorage.getItem('flo_application_id') || '',
  csrf: sessionStorage.getItem('flo_csrf') || '', application: null, step: 0 };
const $ = (id) => document.getElementById(id);
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(route, method = 'GET', data) {
  const response = await fetch(`/flo/api/${route}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-flo-application-id': state.applicationId,
      ...(method === 'GET' ? {} : { 'x-flo-csrf': state.csrf }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.gaps?.length ? `Complete: ${result.gaps.join(', ')}` : result.error || 'Request failed');
  return result;
}
function render() {
  const app = state.application; const schema = app.presentation;
  $('title').textContent = schema.name; document.title = schema.name;
  $('subtitle').textContent = `${app.brand_name || 'Your buyer'} requested this information for supplier onboarding.`;
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
  $('back').hidden = state.step === 0; $('next').hidden = state.step === schema.stages.length - 1;
  $('submit').hidden = state.step !== schema.stages.length - 1;
  if (app.restart) { const banner = document.createElement('section'); banner.className = 'restart';
    const heading = document.createElement('strong'); heading.textContent = 'Changes requested';
    const details = document.createElement('p'); details.textContent = app.restart.comments;
    const targets = document.createElement('p'); targets.textContent = [...(app.restart.fields || []), ...(app.restart.documents || [])].join(', ');
    banner.append(heading, details, targets); $('form').prepend(banner); }
}
async function saveStep() {
  const inputs = [...$('form').querySelectorAll('input,select,textarea')]; const draft = {}; const declarations = {};
  for (const input of inputs) {
    if (input.type === 'file' || input.type === 'checkbox') continue;
    if (!input.checkValidity()) { input.reportValidity(); throw new Error(`Check ${input.name}`); }
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
async function action(operation) { notice(''); const buttons = [$('back'), $('next'), $('submit')]; buttons.forEach((button) => button.disabled = true);
  try { await operation(); } catch (error) { notice(error.message); } finally { buttons.forEach((button) => button.disabled = false); } }
$('back').addEventListener('click', () => { state.step--; render(); window.scrollTo(0, 0); });
$('next').addEventListener('click', () => action(async () => { await saveStep(); state.step++; render(); window.scrollTo(0, 0); }));
$('submit').addEventListener('click', () => action(async () => { await saveStep(); const result = await api('submit', 'POST', {});
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
    render();
  } catch (error) { notice(error.message); $('form').hidden = true; document.querySelector('.actions').hidden = true; }
}
start();
