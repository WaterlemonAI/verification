const config = { maxFileMB: 6, enhancedDueDiligence: true };
const form = document.getElementById("supplier-form");
const panels = [...document.querySelectorAll(".form-step")];
const steps = [...document.querySelectorAll(".step-list li")];
const alertBox = document.getElementById("form-alert");
const nextButton = document.getElementById("next-button");
const backButton = document.getElementById("back-button");
const submitButton = document.getElementById("submit-button");
let currentStep = 0;
let ownerIndex = 1;
let applicationId = sessionStorage.getItem('flo_application_id') || '';
let csrfToken = sessionStorage.getItem('flo_csrf') || '';
const uploadedTypes = new Set();

function gapLabel(name) {
  if (name === 'owners') return 'Current owners and controllers';
  if (name === 'controlledTest') return 'Sample-only applications cannot be submitted';
  const input = form.elements.namedItem(name);
  return input?.labels?.[0]?.textContent?.replace('*', '').trim()
    || name.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
}

async function floApi(path, method = 'GET', value) {
  const response = await fetch(`/flo/api/${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-flo-application-id': applicationId,
      ...(method === 'GET' ? {} : { 'x-flo-csrf': csrfToken }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.gaps?.length
      ? `Please complete: ${result.gaps.map(gapLabel).join(', ')}.`
      : result.error || `Request failed (${response.status}).`);
    error.failureUrl = result.failure_url;
    throw error;
  }
  return result;
}

document.getElementById("buyer-name").textContent = config.buyerName || "Your Organisation";
document.getElementById("enhanced-fields").hidden = !config.enhancedDueDiligence;

function value(id) { return document.getElementById(id)?.value?.trim() || ""; }
function isVisible(element) { return !element.closest("[hidden]"); }
function isApplicable(element) { return !element.closest("[hidden]:not(.form-step)"); }
function personaliseBuyerCopy(buyerName) {
  for (const container of [document.querySelector('.sidebar'), form]) {
    const text = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (text.nextNode()) text.currentNode.nodeValue = text.currentNode.nodeValue.replaceAll('Your Organisation', buyerName);
  }
}
function markUploaded(type) {
  const input = form.elements.namedItem(type);
  if (!input || input.type !== 'file') return;
  let status = input.parentElement.querySelector('.upload-status');
  if (!status) {
    status = document.createElement('span');
    status.className = 'upload-status';
    status.setAttribute('role', 'status');
    input.insertAdjacentElement('afterend', status);
  }
  status.textContent = 'Uploaded. Choose another file if you need to add a newer copy.';
}

function updateConditional() {
  const type = value("supplierType");
  const conditions = {
    legal_entity: type === "legal_entity",
    natural_person: type === "natural_person",
    power_of_attorney: type === "legal_entity" && value("authorityBasis") === "power_of_attorney",
    board_resolution: type === "legal_entity" && value("authorityBasis") === "board_resolution",
    employee_authorisation: type === "legal_entity" && value("authorityBasis") === "employee_authorisation",
    additional_owners: type === "legal_entity" && value("ownershipComplete") === "no",
    different_address: value("registeredAddressSame") === "no",
    key_person_changes: Number(value("keyPersonChanges")) > 0,
    address_changes: Number(value("addressChanges")) > 0,
    unusual_capacity: value("unusualCapacity") === "yes",
    vat_yes: value("vatRegistered") === "yes",
    vat_no: value("vatRegistered") === "no",
    third_party: value("thirdPartyPayments") === "yes",
    cash: value("cashPayment") === "yes",
    goods: ["goods", "both"].includes(value("supplyType")),
    goods_rights_other: ["goods", "both"].includes(value("supplyType")) && value("goodsRights") === "other",
    intermediary_yes: value("intermediary") === "yes"
  };
  document.querySelectorAll("[data-when]").forEach(element => {
    element.hidden = !conditions[element.dataset.when];
  });
}

function clearErrors() {
  alertBox.hidden = true;
  alertBox.textContent = "";
  form.querySelectorAll("[aria-invalid=true]").forEach(element => element.removeAttribute("aria-invalid"));
  form.querySelectorAll(".field-error").forEach(element => element.remove());
}

function showAlert(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
  alertBox.scrollIntoView({ block: "center", behavior: "smooth" });
}

function markError(input, message) {
  input.setAttribute("aria-invalid", "true");
  const wrapper = input.closest(".field") || input.closest(".check-row");
  if (!wrapper) return;
  const error = document.createElement("span");
  error.className = "field-error";
  error.textContent = message;
  wrapper.appendChild(error);
}

function validatePanel(index) {
  clearErrors();
  const panel = panels[index];
  const inputs = [...panel.querySelectorAll("input, select, textarea")].filter(isVisible);
  let firstInvalid = null;
  for (const input of inputs) {
    let message = "";
    if (input.required && input.type === "checkbox" && !input.checked) message = "Please confirm this declaration.";
    else if (input.required && input.type === "file" && !input.files.length && !uploadedTypes.has(input.name)) message = "Please upload this document.";
    else if (input.required && input.type !== "checkbox" && input.type !== "file" && !input.value.trim()) message = "This field is required.";
    else if (input.value && !input.checkValidity()) message = input.id === "trn" ? "Enter a 15-digit TRN." : "Please check the format of this value.";
    if (input.type === "file" && input.files.length) {
      const file = input.files[0];
      if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) message = "Use a PDF, JPG or PNG file.";
      else if (input.id === "locationEvidenceFile" && value("locationEvidenceType") === "ejari" && !/\.pdf$/i.test(file.name)) message = "Upload the Ejari as a PDF.";
      else if (file.size > (config.maxFileMB || 10) * 1024 * 1024) message = `File must be ${config.maxFileMB || 10} MB or smaller.`;
    }
    if (message) { markError(input, message); firstInvalid ||= input; }
  }
  if (firstInvalid) {
    showAlert("Please complete the highlighted fields before continuing.");
    firstInvalid.focus();
    return false;
  }
  return true;
}

function showStep(index, scrollToForm = true) {
  currentStep = index;
  clearErrors();
  panels.forEach((panel, i) => panel.hidden = i !== index);
  steps.forEach((step, i) => { step.classList.toggle("active", i === index); step.classList.toggle("complete", i < index); });
  document.getElementById("progress-label").textContent = `${index + 1} of ${panels.length}`;
  document.getElementById("progress-fill").style.width = `${(index + 1) / panels.length * 100}%`;
  backButton.hidden = index === 0;
  nextButton.hidden = index === panels.length - 1;
  submitButton.hidden = index !== panels.length - 1;
  updateConditional();
  if (scrollToForm) document.querySelector(".content-area").scrollIntoView({ block: "start", behavior: "smooth" });
  if (scrollToForm) panels[index].querySelector("h2")?.focus({ preventScroll: true });
}

form.addEventListener("input", event => {
  if (event.target.matches("input,select,textarea")) {
    event.target.removeAttribute("aria-invalid");
    event.target.closest(".field, .check-row")?.querySelector(".field-error")?.remove();
  }
  updateConditional();
});
form.addEventListener("change", updateConditional);
nextButton.addEventListener("click", async () => {
  if (!validatePanel(currentStep)) return;
  nextButton.disabled = true;
  try { await saveProgress(currentStep); }
  catch (error) { showAlert(error.message); nextButton.disabled = false; return; }
  nextButton.disabled = false;
  showStep(currentStep + 1);
});
backButton.addEventListener("click", () => showStep(currentStep - 1));
document.getElementById("add-owner").addEventListener("click", () => {
  const index = ownerIndex++;
  const row = document.createElement("div");
  row.className = "owner-row";
  row.dataset.ownerRow = index;
  row.innerHTML = `<div class="owner-row-title">Person ${index + 1}<button type="button" class="remove-owner" aria-label="Remove person ${index + 1}">Remove</button></div><div class="owner-fields"><div class="field"><label for="ownerName${index}">Full name <b>*</b></label><input id="ownerName${index}" name="ownerName${index}" required></div><div class="field"><label for="ownerRole${index}">Role / basis of control <b>*</b></label><input id="ownerRole${index}" name="ownerRole${index}" required></div><div class="field"><label for="ownerShare${index}">Ownership %</label><input id="ownerShare${index}" name="ownerShare${index}" type="number" min="0" max="100" step="0.01"></div><div class="field"><label for="ownerNationality${index}">Nationality</label><input id="ownerNationality${index}" name="ownerNationality${index}"></div></div>`;
  document.getElementById("owners-list").append(row);
  row.querySelector("input").focus();
});
document.getElementById("owners-list").addEventListener("click", event => {
  if (event.target.matches(".remove-owner")) event.target.closest(".owner-row").remove();
});

function collectDraft() {
  const draft = {};
  if (value("supplierType") === "legal_entity" && value("ownershipComplete") === "no") {
    draft.owners = [...document.querySelectorAll("[data-owner-row]")].map(row => {
      const index = row.dataset.ownerRow;
      return {
        fullName: value(`ownerName${index}`), role: value(`ownerRole${index}`),
        share: value(`ownerShare${index}`), nationality: value(`ownerNationality${index}`)
      };
    });
  }
  for (const input of form.elements) {
    if (!input.name || !isApplicable(input)) continue;
    if (/^owner(Name|Role|Share|Nationality)\d+$/.test(input.name)) continue;
    if (input.type === 'file') continue;
    if (input.type === 'checkbox') draft[input.name] = input.checked;
    else draft[input.name] = input.value.trim();
  }
  return draft;
}

async function saveProgress(panelIndex = null) {
  await floApi('draft', 'POST', collectDraft());
  const source = panelIndex == null ? form : panels[panelIndex];
  for (const input of source.querySelectorAll('input[type=file]')) {
    const file = input.files?.[0];
    if (!file) continue;
    if (file.size > 6 * 1024 * 1024) throw new Error(`${input.name} must be 6 MB or smaller.`);
    const content_base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = reject;
      reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
    });
    const mime_type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf'
      : /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg');
    await floApi('documents', 'POST', { type: input.name, mime_type, content_base64 });
    uploadedTypes.add(input.name); input.value = ''; markUploaded(input.name);
  }
}

function showReceipt(reference) {
  form.replaceChildren();
  const section = document.createElement('section');
  section.className = 'confirmation';
  section.setAttribute('role', 'status');
  const icon = document.createElement('span');
  icon.className = 'confirmation-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '✓';
  const heading = document.createElement('h2');
  heading.textContent = 'Thank you — your application was submitted';
  const copy = document.createElement('p');
  const buyerName = document.getElementById('buyer-name').textContent || 'Your Organisation';
  copy.textContent = `${buyerName} will review your information and documents and contact you if they need clarification or more evidence.`;
  const label = document.createElement('span');
  label.className = 'confirmation-label';
  label.textContent = 'Your reference';
  const identifier = document.createElement('strong');
  identifier.className = 'confirmation-reference';
  identifier.textContent = reference || applicationId;
  const note = document.createElement('p');
  note.className = 'confirmation-note';
  note.textContent = 'You can close this page. Submission does not mean the application has been approved.';
  section.append(icon, heading, copy, label, identifier, note);
  form.append(section);
  document.querySelector('.sidebar-intro h1').textContent = 'Thank you for submitting.';
  document.querySelector('.sidebar-intro p').textContent = `${buyerName} will take it from here and contact you if they need anything else.`;
  document.querySelector('.progress-block').hidden = true;
  document.querySelector('.step-list').hidden = true;
  document.getElementById('draft-state').textContent = 'Submitted';
  document.getElementById('draft-state').classList.add('submitted');
  section.scrollIntoView({ block: 'start' });
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentStep !== panels.length - 1 || !validatePanel(currentStep)) return;
  submitButton.disabled = true;
  submitButton.textContent = 'Submitting…';
  try {
    await saveProgress(currentStep);
    const result = await floApi('submit', 'POST', {});
    showReceipt(result.application_id);
  } catch (error) {
    showAlert(error.message || 'We could not submit your application. Please try again.');
    submitButton.disabled = false;
    submitButton.innerHTML = 'Submit Application <span aria-hidden="true">→</span>';
  }
});

updateConditional();
showStep(0, false);

async function start() {
  const token = /^\/f\/([A-Za-z0-9_-]{40,100})$/.exec(location.pathname)?.[1];
  try {
    if (token) {
      const session = await floApi('session', 'POST', { token });
      applicationId = session.application_id; csrfToken = session.csrf_token;
      sessionStorage.setItem('flo_application_id', applicationId);
      sessionStorage.setItem('flo_csrf', csrfToken);
      history.replaceState(null, '', '/flo');
    }
    if (!applicationId) throw new Error('Open the supplier link provided by your buyer.');
    const { application } = await floApi('application');
    const buyerName = application.brand_name || 'Your Organisation';
    document.getElementById('buyer-name').textContent = buyerName;
    personaliseBuyerCopy(buyerName);
    document.querySelector('.content-kicker').textContent = `${buyerName} supplier information`;
    document.title = `Supplier onboarding · ${buyerName}`;
    for (const [field, content] of Object.entries(application.draft || {})) {
      const input = form.elements.namedItem(field);
      if (!input || field === 'owners') continue;
      if (input.type === 'checkbox') input.checked = content === true;
      else if (typeof content === 'string') input.value = content;
    }
    for (const document of application.documents || []) {
      uploadedTypes.add(document.type); markUploaded(document.type);
    }
    const owners = application.draft?.owners || [];
    owners.forEach((owner, index) => {
      if (index) document.getElementById('add-owner').click();
      for (const [name, value] of Object.entries({ Name: owner.fullName, Role: owner.role,
        Share: owner.share, Nationality: owner.nationality })) {
        const input = document.getElementById(`owner${name}${index}`);
        if (input && value != null) input.value = value;
      }
    });
    updateConditional();
    if (application.restart && application.status === 'restarted') {
      const banner = document.createElement('div'); banner.className = 'form-alert';
      const heading = document.createElement('strong'); heading.textContent = 'Your buyer requested changes';
      const message = document.createElement('p'); message.textContent = application.restart.comments;
      const targets = document.createElement('p');
      targets.textContent = [...(application.restart.fields || []), ...(application.restart.documents || [])].join(', ');
      banner.append(heading, message, targets); form.prepend(banner);
    }
    if (!['in_progress', 'restarted'].includes(application.status)) {
      if (application.submitted_at || ['submitted', 'processing', 'pending_review', 'needs_correction', 'accepted', 'rejected'].includes(application.status))
        showReceipt(application.application_id);
      else showAlert('This application is no longer available. Contact Your Organisation for a new link.');
      return;
    }
  } catch (error) {
    if (error.failureUrl) { location.assign(error.failureUrl); return; }
    showAlert(error.message);
    for (const button of [nextButton, submitButton]) button.disabled = true;
  }
}
start();
