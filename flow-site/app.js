let applicationId = sessionStorage.getItem('flo_application_id') || '';
let csrfToken = sessionStorage.getItem('flo_csrf') || '';
const $ = (id) => document.getElementById(id);
function show(id) { for (const section of ['loading', 'error', 'journey', 'complete']) $(section).hidden = section !== id; }
function fail(message) { $('error').textContent = message; show('error'); }
async function api(path, method = 'GET', value) {
  const response = await fetch(`/flo/api/${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-flo-application-id': applicationId,
      ...(method !== 'GET' ? { 'x-flo-csrf': csrfToken } : {}) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.gaps ? `Missing: ${result.gaps.join(', ')}` : result.error || 'Request failed.');
    error.failureUrl = result.failure_url;
    throw error;
  }
  return result;
}
function renderDocuments(documents) {
  $('document-list').replaceChildren(...documents.map((doc) => {
    const li = document.createElement('li'); li.textContent = `${doc.type.replaceAll('_', ' ')} · ${Math.round(doc.size / 1024)} KB · saved`; return li;
  }));
}
function addStakeholder(item = {}) {
  const div = document.createElement('div'); div.className = 'stakeholder';
  for (const [name, label, type] of [['name', 'Name', 'text'], ['role', 'Role', 'text'], ['ownership_percentage', 'Ownership %', 'number']]) {
    const field = document.createElement('label'); field.textContent = label;
    const input = document.createElement('input'); input.name = name; input.type = type; input.value = item[name] ?? '';
    if (type === 'number') { input.min = 0; input.max = 100; input.step = '0.01'; }
    field.append(input); div.append(field);
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
  remove.addEventListener('click', () => div.remove()); div.append(remove); $('stakeholders').append(div);
}
async function start() {
  const token = /^\/f\/([A-Za-z0-9_-]{40,100})$/.exec(location.pathname)?.[1];
  if (token) {
    try {
      const result = await api('session', 'POST', { token });
      applicationId = result.application_id; csrfToken = result.csrf_token;
      sessionStorage.setItem('flo_application_id', applicationId); sessionStorage.setItem('flo_csrf', csrfToken);
      history.replaceState(null, '', '/flo');
    } catch (error) {
      if (error.failureUrl) { location.assign(error.failureUrl); return; }
      fail(error.message); return;
    }
  }
  if (!applicationId) { fail('Open the supplier link supplied to you.'); return; }
  try {
    const { application } = await api('application');
    if (application.status !== 'in_progress') { show('complete'); return; }
    for (const [key, value] of Object.entries(application.draft || {})) {
      const input = $('details').elements.namedItem(key); if (input && typeof value === 'string') input.value = value;
    }
    for (const item of application.draft?.stakeholders || []) addStakeholder(item);
    renderDocuments(application.documents || []); show('journey');
    if (application.preview_ready_at) renderReview(application);
  } catch (error) { fail(error.message); }
}
$('add-stakeholder').addEventListener('click', () => addStakeholder());
$('details').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const draft = Object.fromEntries([...new FormData(event.target)].filter(([, value]) => value));
  draft.stakeholders = [...document.querySelectorAll('.stakeholder')].map((div) => {
    const item = {};
    for (const input of div.querySelectorAll('input')) if (input.value) item[input.name] = input.value;
    return item;
  });
  try { await api('draft', 'POST', draft); $('evidence-review').hidden = true;
    $('message').textContent = 'Details saved. Review extracted values again before submitting.'; }
  catch (error) { $('message').textContent = error.message; } finally { button.disabled = false; }
});
$('upload').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const file = event.target.elements.file.files[0];
  if (!file || file.size > 6 * 1024 * 1024) { $('message').textContent = 'Choose a file up to 6 MB.'; button.disabled = false; return; }
  try {
    const content_base64 = await new Promise((resolve, reject) => { const reader = new FileReader();
      reader.onerror = reject; reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
    const { document: saved } = await api('documents', 'POST', { type: event.target.elements.type.value, mime_type: file.type, content_base64 });
    const li = document.createElement('li'); li.textContent = `${saved.type.replaceAll('_', ' ')} · saved`; $('document-list').append(li);
    event.target.reset(); $('evidence-review').hidden = true; $('message').textContent = 'Document saved. Review extracted values again before submitting.';
  } catch (error) { $('message').textContent = error.message; } finally { button.disabled = false; }
});
function renderReview(application) {
  const container = $('extracted-fields'); container.replaceChildren();
  for (const doc of application.documents || []) {
    const section = document.createElement('section');
    const heading = document.createElement('h3'); heading.textContent = doc.type.replaceAll('_', ' ');
    const details = document.createElement('pre'); details.textContent = doc.extraction_result?.data
      ? JSON.stringify(doc.extraction_result.data, null, 2) : `Extraction ${doc.extraction_state || 'not_run'}${doc.extraction_reason ? ': ' + doc.extraction_reason : ''}`;
    section.append(heading, details); container.append(section);
  }
  const compare = document.createElement('section'); const title = document.createElement('h3'); title.textContent = 'Source comparisons';
  const details = document.createElement('ul');
  for (const item of application.comparisons || []) {
    const row = document.createElement('li'); row.textContent = `${item.rule.replaceAll('_', ' ')}: ${item.outcome}`; details.append(row);
  }
  compare.append(title, details); container.append(compare); $('evidence-review').hidden = false;
}
$('review').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try {
    await api('review', 'POST', {}); $('message').textContent = 'Extracting and comparing the documents. This may take several minutes.';
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const { application } = await api('application');
      if (application.preview_ready_at) { renderReview(application); $('message').textContent = 'Review the values, save any correction, then submit.'; return; }
    }
    $('message').textContent = 'Review is still processing. You can return to this page later.';
  } catch (error) { $('message').textContent = error.message; } finally { event.target.disabled = false; }
});
$('submit').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try { const result = await api('submit', 'POST', {}); show('complete');
    if (result.success_url) setTimeout(() => location.assign(result.success_url), 2000);
  } catch (error) { $('message').textContent = error.message; } finally { event.target.disabled = false; }
});
start();
