const config = { maxFileMB: 6, enhancedDueDiligence: true, controlledTestEnabled: false };
const form = document.getElementById("supplier-form");
const panels = [...document.querySelectorAll(".form-step")];
const steps = [...document.querySelectorAll(".step-list li")];
const alertBox = document.getElementById("form-alert");
const nextButton = document.getElementById("next-button");
const backButton = document.getElementById("back-button");
const submitButton = document.getElementById("submit-button");
const reviewStatus = document.getElementById("review-status");
const reviewModal = document.getElementById("review-modal");
let currentStep = 0;
let ownerIndex = 1;
let reviewResult = null;
let reviewing = false;
let modalTargetStep = 0;
let applicationId = sessionStorage.getItem('flo_application_id') || '';
let csrfToken = sessionStorage.getItem('flo_csrf') || '';
const uploadedTypes = new Set();

async function floApi(path, method = 'GET', value) {
  const response = await fetch(`/flo/api/${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-flo-application-id': applicationId,
      ...(method === 'GET' ? {} : { 'x-flo-csrf': csrfToken }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.gaps ? `Missing: ${result.gaps.join(', ')}` : result.error || `Request failed (${response.status}).`);
    error.failureUrl = result.failure_url;
    throw error;
  }
  return result;
}

document.getElementById("buyer-name").textContent = config.buyerName || "Your Organisation";
document.getElementById("enhanced-fields").hidden = !config.enhancedDueDiligence;
const controlledTestEnabled = config.controlledTestEnabled === true && ["127.0.0.1", "localhost"].includes(window.location.hostname);
document.getElementById("controlled-test-option").hidden = !controlledTestEnabled;

function value(id) { return document.getElementById(id)?.value?.trim() || ""; }
function isVisible(element) { return !element.closest("[hidden]"); }
function isApplicable(element) { return !element.closest("[hidden]:not(.form-step)"); }

function updateConditional() {
  const testMode = controlledTestEnabled && document.getElementById("controlledTest").checked;
  document.getElementById("accuracy-declaration-row").hidden = testMode;
  document.getElementById("screening-consent-row").hidden = testMode;
  document.getElementById("test-declaration-row").hidden = !testMode;
  document.getElementById("accuracyDeclaration").required = !testMode;
  document.getElementById("screeningConsent").required = !testMode;
  document.getElementById("testDeclaration").required = testMode;
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

function renderSummary() {
  const items = [
    ["Supplier type", value("supplierType") === "natural_person" ? "Individual / sole supplier" : "Legal entity"],
    ["Trade licence", uploadedTypes.has('tradeLicenceFile') ? 'Saved' : document.getElementById("tradeLicenceFile")?.files[0]?.name || "Not applicable"],
    ["Identity document", uploadedTypes.has('identityFile') ? 'Saved' : document.getElementById("identityFile")?.files[0]?.name || "—"],
    ["Location evidence", uploadedTypes.has('locationEvidenceFile') ? 'Saved' : document.getElementById("locationEvidenceFile")?.files[0]?.name || "—"],
    ["VAT status", document.getElementById("controlledTest").checked ? "Test answer · confirm with supplier" : value("vatRegistered") === "yes" ? "Registered · certificate provided" : "Not registered"],
    ["Bank confirmation", uploadedTypes.has('bankConfirmationFile') ? 'Saved' : document.getElementById("bankConfirmationFile")?.files[0]?.name || "—"],
    ["Proposed supply", value("supplyType") || "—"]
  ];
  const container = document.getElementById("review-summary");
  container.replaceChildren();
  for (const [label, content] of items) {
    const card = document.createElement("div");
    card.className = "review-card";
    const title = document.createElement("span");
    title.textContent = label;
    const detail = document.createElement("strong");
    detail.textContent = content || "—";
    card.append(title, detail);
    container.append(card);
  }
}

function showReviewModal(title, messages, targetStep = 0) {
  modalTargetStep = targetStep;
  document.getElementById("review-modal-title").textContent = title;
  const body = document.getElementById("review-modal-body");
  body.replaceChildren();
  const list = document.createElement("ul");
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = message;
    list.append(item);
  }
  body.append(list);
  reviewModal.hidden = false;
  document.getElementById("correct-review-modal").focus();
}

function closeReviewModal() {
  reviewModal.hidden = true;
  document.getElementById("retry-verification").focus();
}

function renderScreening(screening) {
  const grid = document.getElementById("screening-grid");
  const scope = document.getElementById("screening-scope");
  grid.replaceChildren();
  if (!screening?.subjects?.length) {
    scope.textContent = "No supplier or stakeholder names were available for screening. Buyer review is required.";
    return;
  }
  scope.textContent = screening.enabled
    ? "AML checks: PEP, sanctions and watchlists. A separate AML dataset is not connected. Potential matches and incomplete checks require buyer review."
    : "Automated screening was not run. Buyer review is required.";
  const label = { clear: "No potential match returned", review: "Buyer review needed",
    unavailable: "Unavailable", not_run: "Not run" };
  for (const subject of screening.subjects) {
    const card = document.createElement("article");
    card.className = "screening-card";
    const name = document.createElement("strong");
    name.textContent = subject.name;
    const role = document.createElement("small");
    role.textContent = (subject.roles || []).join(" · ") || (subject.type === "business" ? "Business" : "Person");
    card.append(name, role);
    for (const [title, status] of [["AML: PEP, sanctions, watchlists", subject.aml], ["Adverse media", subject.adverseMedia]]) {
      const row = document.createElement("div");
      row.className = "screening-check";
      row.dataset.state = status || "unavailable";
      const check = document.createElement("span");
      check.textContent = title;
      const outcome = document.createElement("b");
      outcome.textContent = label[status] || label.unavailable;
      row.append(check, outcome);
      card.append(row);
    }
    grid.append(card);
  }
}

function renderVerification(result) {
  renderScreening(result.screening);
  const grid = document.getElementById("verification-grid");
  grid.replaceChildren();
  for (const field of result.fields || []) {
    const card = document.createElement("div");
    card.className = `verification-card status-${field.status || "unknown"}`;
    const label = document.createElement("span");
    label.className = "verification-label";
    label.textContent = field.label || field.key || "Verification detail";
    const valueText = document.createElement("strong");
    valueText.textContent = field.value == null || field.value === "" ? "Not returned" : String(field.value);
    const source = document.createElement("small");
    source.textContent = `${field.source || "Source unavailable"} · ${field.status || "unknown"}`.replaceAll("_", " ");
    card.append(label, valueText, source);
    grid.append(card);
  }
  if (!grid.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "verification-empty";
    empty.textContent = "No verified fields are available yet.";
    grid.append(empty);
  }
  const manager = document.getElementById("manager-review");
  manager.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = result.manager?.status === "completed" ? "Gemini application manager review" : "Application manager review unavailable";
  const copy = document.createElement("p");
  copy.textContent = result.manager?.summary || "The review could not be completed. Please try again or contact the supplier team.";
  manager.append(heading, copy);
  if (result.manager?.status === "completed") {
    const progress = document.createElement("p");
    progress.textContent = `${result.manager.reviewedFieldCount || 0} of ${result.manager.fieldCount || 0} returned fields received a Gemini review; ${result.manager.uncertainFieldCount || 0} were marked uncertain.`;
    manager.append(progress);
  }
  const issues = result.issues || [];
  if (issues.length) {
    const list = document.createElement("ul");
    for (const issue of issues) {
      const item = document.createElement("li");
      item.textContent = issue.message;
      list.append(item);
    }
    manager.append(list);
  }
  reviewStatus.textContent = result.decision === "ready" ? "Verification complete. Review the extracted values before submitting." :
    result.decision === "manual_review" ? "Verification complete with items for Your Organisation to review." :
    result.decision === "needs_correction" ? "Verification found information that needs correction." :
    "Verification could not be completed.";
  if (result.controlledTest) reviewStatus.textContent = `Controlled test — no supplier attestation or submission. ${reviewStatus.textContent}`;
  reviewStatus.dataset.state = result.decision || "unavailable";
  document.getElementById("download-review").disabled = !result.applicationSummary;
  submitButton.disabled = document.getElementById("controlledTest").checked || !["ready", "manual_review"].includes(result.decision);
  if (issues.length) showReviewModal("Information needs attention", issues.map(issue => issue.message), issues.find(issue => issue.severity === "error")?.step ?? issues[0]?.step ?? 0);
}

async function runVerification() {
  if (reviewing) return;
  reviewing = true;
  reviewResult = null;
  document.getElementById("download-review").disabled = true;
  submitButton.disabled = true;
  document.getElementById("retry-verification").disabled = true;
  reviewStatus.textContent = "Extracting documents and checking the information. This can take a few minutes…";
  reviewStatus.dataset.state = "processing";
  document.getElementById("verification-grid").replaceChildren();
  document.getElementById("screening-grid").replaceChildren();
  document.getElementById("screening-scope").textContent = "Document and verification checks are running…";
  document.getElementById("manager-review").replaceChildren();
  try {
    await saveProgress();
    await floApi('review', 'POST', {});
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const { application } = await floApi('application');
      if (application.preview_ready_at) {
        reviewResult = supplierReview(application);
        renderVerification(reviewResult);
        return;
      }
    }
    reviewStatus.textContent = 'Verification is still running. You can return to this page later.';
  } catch (error) {
    reviewStatus.textContent = "Verification unavailable. Your information has not been submitted.";
    reviewStatus.dataset.state = "unavailable";
    document.getElementById("screening-scope").textContent = "Screening could not be completed.";
    showReviewModal("Verification could not run", [error.message || "Please try again later."]);
  } finally {
    reviewing = false;
    document.getElementById("retry-verification").disabled = false;
  }
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
  nextButton.innerHTML = index === panels.length - 2 ? 'Review extracted information <span aria-hidden="true">→</span>' : 'Continue <span aria-hidden="true">→</span>';
  if (index === panels.length - 1) renderSummary();
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
  if (currentStep < panels.length - 1) reviewResult = null;
});
form.addEventListener("change", () => { updateConditional(); if (currentStep < panels.length - 1) reviewResult = null; });
nextButton.addEventListener("click", async () => {
  if (!validatePanel(currentStep)) return;
  nextButton.disabled = true;
  try { await saveProgress(currentStep); }
  catch (error) { showAlert(error.message); nextButton.disabled = false; return; }
  nextButton.disabled = false;
  const enteringReview = currentStep === panels.length - 2;
  showStep(currentStep + 1);
  if (enteringReview) await runVerification();
});
backButton.addEventListener("click", () => showStep(currentStep - 1));
document.getElementById("retry-verification").addEventListener("click", runVerification);
document.getElementById("download-review").addEventListener("click", () => {
  if (!reviewResult) return;
  const file = new Blob([JSON.stringify(reviewResult, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `supplier-onboarding-review-${applicationId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.getElementById("close-review-modal").addEventListener("click", closeReviewModal);
document.getElementById("correct-review-modal").addEventListener("click", () => { closeReviewModal(); showStep(modalTargetStep); });
reviewModal.addEventListener("click", event => { if (event.target.classList.contains("review-modal-backdrop")) closeReviewModal(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && !reviewModal.hidden) closeReviewModal(); });
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
    uploadedTypes.add(input.name); input.value = '';
  }
}

function supplierReview(application) {
  const fields = [];
  for (const doc of application.documents || []) {
    for (const [key, value] of Object.entries(doc.extraction_result?.data || {}))
      fields.push({ key: `${doc.type}.${key}`, label: key.replaceAll('_', ' '),
        value: typeof value === 'object' ? JSON.stringify(value) : value,
        source: doc.type, status: 'extracted' });
  }
  for (const comparison of application.comparisons || []) fields.push({
    key: comparison.rule, label: comparison.rule.replaceAll('_', ' '), value: comparison.outcome,
    source: 'Cross-document comparison', status: comparison.outcome === 'match' ? 'verified' : 'review_required'
  });
  const issues = application.preview_issues || [];
  const decision = issues.some(issue => issue.severity === 'error') ? 'needs_correction' : 'manual_review';
  return { fields, issues, decision, applicationSummary: application,
    screening: application.screening_summary || { enabled: false, subjects: [] },
    manager: { status: 'not_run', summary: 'Buyer review follows secure submission. Correct any document issues shown here first.' } };
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!validatePanel(currentStep)) return;
  if (document.getElementById("controlledTest").checked) {
    showReviewModal("Controlled test only", ["This test review cannot be submitted as a supplier application."]);
    return;
  }
  if (!reviewResult || !["ready", "manual_review"].includes(reviewResult.decision)) {
    showReviewModal("Verification is required", ["Run verification and resolve any required corrections before submitting."]);
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Submitting…";
  try {
    const result = await floApi('submit', 'POST', {});
    form.replaceChildren();
    const confirmation = document.createElement("div");
    confirmation.className = "field-card confirmation";
    const heading = document.createElement("h2");
    heading.textContent = "Your information was submitted";
    const copy = document.createElement("p");
    copy.textContent = `Reference: ${result.application_id}. Your Organisation may contact you if more information is needed.`;
    confirmation.append(heading, copy);
    form.append(confirmation);
    const state = document.getElementById("draft-state");
    state.textContent = "Submitted";
    state.classList.add("submitted");
    if (result.success_url) setTimeout(() => location.assign(result.success_url), 2000);
  } catch (error) {
    showAlert(error.message || "We could not submit this form. Please try again.");
    submitButton.disabled = false;
    submitButton.innerHTML = 'Submit securely <span aria-hidden="true">→</span>';
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
    document.getElementById('buyer-name').textContent = application.brand_name || 'Your Organisation';
    for (const [field, content] of Object.entries(application.draft || {})) {
      const input = form.elements.namedItem(field);
      if (!input || field === 'owners') continue;
      if (input.type === 'checkbox') input.checked = content === true;
      else if (typeof content === 'string') input.value = content;
    }
    for (const document of application.documents || []) uploadedTypes.add(document.type);
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
    if (application.status !== 'in_progress') {
      form.replaceChildren(); const message = document.createElement('h2');
      message.textContent = `Application ${application.status.replaceAll('_', ' ')}`; form.append(message);
      return;
    }
    if (application.preview_ready_at) { showStep(4, false); reviewResult = supplierReview(application); renderVerification(reviewResult); }
  } catch (error) {
    if (error.failureUrl) { location.assign(error.failureUrl); return; }
    showAlert(error.message);
    for (const button of [nextButton, submitButton]) button.disabled = true;
  }
}
start();
