import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const screenshotDir = process.env.FLO_SMOKE_SCREENSHOT_DIR || '';
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const files = {
  '/f/synthetic-token-abcdefghijklmnopqrstuvwxyz0123456789': ['flow-site/index.html', 'text/html'],
  '/flo': ['flow-site/index.html', 'text/html'],
  '/app.js': ['flow-site/app.js', 'text/javascript'],
  '/styles.css': ['flow-site/styles.css', 'text/css'],
  '/buyer': ['api-site/flo.html', 'text/html'],
  '/flo.js': ['api-site/flo.js', 'text/javascript'],
  '/flo-review.js': ['api-site/flo-review.js', 'text/javascript'],
  '/flo.css': ['api-site/flo.css', 'text/css'],
  '/api.css': ['api-site/api.css', 'text/css'],
  '/portal-auth.js': ['api-site/portal-auth.js', 'text/javascript'],
  '/assets/kycprobe-logo-white.png': ['api-site/assets/kycprobe-logo-white.png', 'image/png']
};
files['/workflows'] = ['api-site/flo-workflows.html', 'text/html'];
files['/flo-workflows.js'] = ['api-site/flo-workflows.js', 'text/javascript'];
files['/flo-workflows.css'] = ['api-site/flo-workflows.css', 'text/css'];
files['/flo-builder.css'] = ['api-site/flo-builder.css', 'text/css'];
files['/flo-builder.js'] = ['api-site/flo-builder.js', 'text/javascript'];
files['/flo-builder-model.js'] = ['api-site/flo-builder-model.js', 'text/javascript'];
files['/flo-schema-view.js'] = ['flow-site/renderer/schema-view.js', 'text/javascript'];
files['/flo-sortable.min.js'] = ['node_modules/sortablejs/Sortable.min.js', 'text/javascript'];
files['/f/generic-token-abcdefghijklmnopqrstuvwxyz0123456789'] = ['flow-site/renderer/index.html', 'text/html'];
files['/assets/renderer/app.js'] = ['flow-site/renderer/app.js', 'text/javascript'];
files['/assets/renderer/schema-view.js'] = ['flow-site/renderer/schema-view.js', 'text/javascript'];
files['/assets/renderer/styles.css'] = ['flow-site/renderer/styles.css', 'text/css'];
files['/f/supplier-token-abcdefghijklmnopqrstuvwxyz0123456789'] = ['flow-site/supplier-onboarding-v1/index.html', 'text/html'];
files['/assets/supplier-onboarding-v1/1.0.0/app.js'] = ['flow-site/supplier-onboarding-v1/app.js', 'text/javascript'];
files['/assets/supplier-onboarding-v1/1.0.0/styles.css'] = ['flow-site/supplier-onboarding-v1/styles.css', 'text/css'];
const server = createServer((req, res) => {
  const entry = files[new URL(req.url, 'http://localhost').pathname];
  if (!entry) { res.writeHead(404); res.end(); return; }
  const bytes = readFileSync(join(root, entry[0]));
  res.writeHead(200, { 'content-type': entry[1], 'content-length': bytes.length }); res.end(bytes);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()) });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const appId = '11111111-1111-4111-8111-111111111111';
    const documents = []; let draft = {}; let preview = false; let submitted = false; let accepted = false;
    let buyerDetailReads = 0;
    await context.route('**/flo/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = route.request().postDataJSON?.() || {};
      let response;
      if (path.endsWith('/session')) response = { application_id: appId, csrf_token: 'synthetic-csrf', draft, documents };
      else if (path.endsWith('/application')) response = { application: { application_id: appId,
        customer_reference: 'SYNTHETIC', status: submitted ? 'submitted' : 'in_progress', draft,
        documents, preview_ready_at: preview ? new Date().toISOString() : null,
        comparisons: preview ? [{ rule: 'licence_formation_name', outcome: 'match' }] : [] } };
      else if (path.endsWith('/draft')) { draft = data; preview = false; response = { draft }; }
      else if (path.endsWith('/documents')) {
        const document = { document_id: `doc-${documents.length + 1}`, type: data.type, size: 20,
          extraction_state: 'completed', extraction_result: { data: { company_name_english: 'Synthetic Trading LLC' } } };
        documents.push(document); preview = false; response = { document };
      } else if (path.endsWith('/review')) { preview = true; response = { status: 'review_processing' }; }
      else if (path.endsWith('/submit')) { submitted = true; response = { status: 'submitted', application_id: appId }; }
      else response = { error: 'Unexpected route' };
      await route.fulfill({ status: path.endsWith('/review') || path.endsWith('/submit') ? 202 : 200,
        contentType: 'application/json', body: JSON.stringify(response) });
    });
    await context.route('**/portal/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let response;
      if (path === '/portal/api/auth/session') response = { account: { client_name: 'Synthetic buyer', email: 'buyer@example.com' }, csrf_token: 'csrf' };
      else if (path === '/portal/api/entitlements') response = { allowed_modules: ['flo'], available_modules: ['flo'] };
      else if (path === '/portal/api/flo/status') response = { enabled: true, workflow_platform_enabled: true };
      else if (path === '/portal/api/flo/flows') response = { flows: [
        { flow_id: 'kys-v1', version: '1.0.0', brand_name: 'Synthetic buyer' },
        { flow_id: 'supplier-onboarding-v1', version: '1.0.0', brand_name: 'Synthetic buyer' }
      ] };
      else if (path === '/portal/api/flo/flows/supplier-onboarding-v1/links') response = {
        application_id: '22222222-2222-4222-8222-222222222222', flow_id: 'supplier-onboarding-v1',
        template_version: '1.0.0', status: 'link_issued',
        supplier_url: 'https://flo.ai7uae.com/f/synthetic-link-abcdefghijklmnopqrstuvwxyz0123456789',
        reused: false
      };
      else if (path === '/portal/api/flo/cases') response = { counts: { open: 0, in_progress: 0, processing_review: accepted ? 0 : 1,
        restarted: 0, accepted: accepted ? 1 : 0, rejected: 0, expired_failed: 0 }, next_cursor: null,
        cases: [{ application_id: appId, customer_reference: 'SYNTHETIC', bucket: accepted ? 'accepted' : 'processing_review',
        flow_id: 'kys-v1', template_version: '1.0.0', status: accepted ? 'accepted' : 'pending_review',
        created_at: new Date().toISOString() }] };
      else if (path.endsWith('/decision')) { accepted = true; response = { status: 'accepted', application_id: appId }; }
      else if (path === `/portal/api/flo/cases/${appId}`) { buyerDetailReads += 1; response = { application: {
        application_id: appId, customer_reference: 'SYNTHETIC', flow_id: 'kys-v1', template_version: '1.0.0',
        supplier_email: 'supplier@example.com',
        status: accepted ? 'accepted' : buyerDetailReads === 1 ? 'processing' : 'pending_review', created_at: new Date().toISOString(),
        review_requirements: { text: ['business_name', 'licence_number'],
          documents: ['trade_licence', 'formation_document', 'bank_letter'] },
        draft: { business_name: 'Synthetic Trading LLC', licence_number: 'LIC-1',
          stakeholders: [{ name: 'Synthetic Owner', role: 'director' }] },
        documents: [{ document_id: 'doc-1', type: 'trade_licence' }],
        subjects: [{ subject_id: appId, name: 'Synthetic Trading LLC', type: 'business' }],
        checks: [{ service_id: 'entity-aml', subject_id: appId, transport: 'completed', coverage: 'partial',
          business_result: 'requires_review', reason_codes: [],
          raw_response: { data: { profiles: [{ basic_details: { entity_name: 'Synthetic Match' } }] } } },
        { service_id: 'entity-adverse-media', subject_id: appId, transport: 'not_run', coverage: 'unavailable',
          business_result: 'could_not_complete', reason_codes: ['input_missing'] }],
        ai7edd_review: { status: 'not_run', reason_codes: ['ai7edd_unconfigured'] },
        reports: [{ version: 1 }], events: [{ at: new Date().toISOString(), type: 'review_ready', actor: 'flo_worker' }] } }; }
      else response = { error: 'Unexpected route' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    const page = await context.newPage();
    await page.addInitScript(() => { const original = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => original(fn, delay === 8000 ? 80 : delay, ...args); });
    await page.goto(`${base}/f/synthetic-token-abcdefghijklmnopqrstuvwxyz0123456789`);
    await page.locator('#journey').waitFor({ state: 'visible' });
    for (const [name, value] of Object.entries({ business_name: 'Synthetic Trading LLC', licence_number: 'LIC-1',
      company_type: 'LLC', activities: 'Trading', registered_address: 'Dubai' }))
      await page.locator(`[name="${name}"]`).fill(value);
    await page.getByRole('button', { name: 'Save details' }).click();
    for (const type of ['trade_licence', 'formation_document', 'bank_letter']) {
      await page.locator('#upload select').selectOption(type);
      await page.locator('#upload input[type=file]').setInputFiles({ name: `${type}.pdf`, mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\nsynthetic') });
      await page.getByRole('button', { name: 'Upload document' }).click();
      await page.getByText(`${type.replaceAll('_', ' ')} · saved`).waitFor();
    }
    await page.getByRole('button', { name: 'Review extracted values' }).click();
    await page.locator('#evidence-review').waitFor({ state: 'visible', timeout: 12000 });
    await page.getByRole('button', { name: 'Confirm and submit for buyer review' }).click();
    await page.locator('#complete').waitFor({ state: 'visible' });
    await page.goto(`${base}/buyer`);
    await page.getByRole('heading', { name: 'Onboarding Applications' }).waitFor();
    if (await page.locator('#flo-link-flow').inputValue() !== '')
      throw new Error('The buyer must choose a flow when multiple flows are enabled.');
    await page.locator('#flo-link-flow').selectOption('supplier-onboarding-v1');
    await page.locator('[name="customer_reference"]').fill('NEW-SUPPLIER');
    await page.locator('[name="supplier_email"]').fill('new@example.com');
    await page.getByRole('button', { name: 'Create link' }).click();
    await page.getByText('Onboarding link created').waitFor();
    await page.getByText('22222222-2222-4222-8222-222222222222').waitFor();
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `flo-buyer-link-${viewport.width}.png`), fullPage: true });
    await page.getByText('1 of 1 loaded applications need buyer attention.').waitFor();
    await page.locator('.flo-attention-cue').getByText(/Buyer review needed/).waitFor();
    await page.getByRole('button', { name: /SYNTHETIC/ }).click();
    await page.locator('#flo-action-status').filter({ hasText: 'Checks are processing · this view refreshes automatically' }).waitFor();
    await page.locator('#flo-action-status').filter({ hasText: 'Buyer review needed · inspect evidence and decide' }).waitFor();
    if (buyerDetailReads < 2) throw new Error('Processing case did not refresh to buyer review.');
    await page.waitForTimeout(250);
    if (buyerDetailReads !== 2) throw new Error('Case continued refreshing after reaching buyer review.');
    await page.getByText('AML', { exact: true }).waitFor();
    await page.locator('.flo-screening-group').first().getByText('Potential flag').waitFor();
    await page.locator('.flo-screening-group').first().getByText(/incomplete coverage/).waitFor();
    await page.locator('.flo-screening-group').nth(1).locator('.flo-screening-status').getByText('Not run').waitFor();
    if (screenshotDir) await page.locator('#flo-panel-overview').screenshot({
      path: join(screenshotDir, `flo-buyer-review-${viewport.width}.png`) });
    await page.locator('.flo-screening-group').first().locator('summary').first().click();
    await page.locator('.flo-screening-evidence').first().locator('summary').click();
    await page.getByText('Synthetic Match').waitFor();
    await page.getByText('Complete application JSON').click();
    const completeJson = await page.locator('.flo-full-json pre').textContent();
    if (!completeJson.includes('ai7edd_review') || completeJson.includes('gemini_review'))
      throw new Error('Full application JSON does not use the AI7EDD review field.');
    await page.getByRole('button', { name: 'Accept' }).click();
    await page.getByText('Status: accepted').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`Flo buyer UI overflows at ${viewport.width}px`);
    await context.close();
    console.log(`Flo supplier and buyer UI passed at ${viewport.width}px`);

    const supplierContext = await browser.newContext({ viewport });
    const supplierDocuments = []; let supplierDraft = {}; let supplierSubmitted = false; let supplierReviewRequests = 0;
    await supplierContext.route('**/flo/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = route.request().postDataJSON?.() || {};
      let response;
      if (path.endsWith('/session')) response = { application_id: appId, csrf_token: 'supplier-csrf' };
      else if (path.endsWith('/application')) response = { application: {
        application_id: appId, flow_id: 'supplier-onboarding-v1', template_version: '1.0.0',
        brand_name: 'Synthetic Buyer', status: supplierSubmitted ? 'submitted' : 'in_progress',
        ...(supplierSubmitted ? { submitted_at: new Date().toISOString() }
          : { draft: supplierDraft, documents: supplierDocuments }) } };
      else if (path.endsWith('/draft')) { supplierDraft = data; response = { draft: data }; }
      else if (path.endsWith('/documents')) {
        const document = { document_id: `supplier-doc-${supplierDocuments.length + 1}`, type: data.type,
          size: 20, extraction_state: 'completed', extraction_result: { data: { company_name_english: 'Synthetic Buyer LLC' } } };
        supplierDocuments.push(document); response = { document };
      } else if (path.endsWith('/review')) { supplierReviewRequests += 1; response = { error: 'Unexpected review request' }; }
      else if (path.endsWith('/submit')) { supplierSubmitted = true; response = { status: 'submitted', application_id: appId }; }
      else response = { error: 'Unexpected route' };
      await route.fulfill({ status: path.endsWith('/review') || path.endsWith('/submit') ? 202 : 200,
        contentType: 'application/json', body: JSON.stringify(response) });
    });
    const supplierPage = await supplierContext.newPage();
    await supplierPage.goto(`${base}/f/supplier-token-abcdefghijklmnopqrstuvwxyz0123456789`);
    await supplierPage.locator('#supplierType').waitFor({ state: 'visible' });
    if (/gemini/i.test(await supplierPage.locator('body').innerText())) throw new Error('Supplier page exposes provider branding.');
    if (await supplierPage.locator('.form-step').count() !== 4) throw new Error('Supplier journey must have four form steps.');
    if (screenshotDir) await supplierPage.screenshot({ path: join(screenshotDir, `flo-supplier-onboarding-${viewport.width}.png`), fullPage: true });
    await supplierPage.locator('#supplierType').selectOption('legal_entity');
    await supplierPage.locator('#tradeLicenceFile').setInputFiles({ name: 'trade.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic') });
    await supplierPage.locator('#next-button').click();
    await supplierPage.locator('#back-button').click();
    await supplierPage.locator('#tradeLicenceFile').locator('..').getByText('Uploaded. Choose another file if you need to add a newer copy.').waitFor();
    await supplierPage.locator('#next-button').click();
    await supplierPage.locator('#representativeEmail').fill('rep@example.com');
    await supplierPage.locator('#representativePhone').fill('+971555550000');
    await supplierPage.locator('#representativeTitle').fill('Director');
    await supplierPage.locator('#identityType').selectOption('emirates_id');
    await supplierPage.locator('#identityFile').setInputFiles({ name: 'id.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic') });
    await supplierPage.locator('#authorityBasis').selectOption('director');
    await supplierPage.locator('#ownershipComplete').selectOption('yes');
    await supplierPage.locator('#locationEvidenceType').selectOption('utility');
    await supplierPage.locator('#locationEvidenceFile').setInputFiles({ name: 'utility.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic') });
    await supplierPage.locator('#registeredAddressSame').selectOption('yes');
    await supplierPage.locator('#siteActivities').fill('Consulting');
    await supplierPage.locator('#addressChanges').fill('0');
    await supplierPage.locator('#keyPersonChanges').fill('0');
    await supplierPage.locator('#next-button').click();
    await supplierPage.locator('#vatRegistered').selectOption('no');
    await supplierPage.locator('#vatReason').fill('Below threshold');
    await supplierPage.locator('#bankConfirmationFile').setInputFiles({ name: 'bank.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic') });
    await supplierPage.locator('#thirdPartyPayments').selectOption('no');
    await supplierPage.locator('#cashPayment').selectOption('no');
    await supplierPage.locator('#next-button').click();
    await supplierPage.locator('#supplyType').selectOption('services');
    await supplierPage.locator('#staffCount').fill('12');
    await supplierPage.locator('#supplyDescription').fill('Consulting services');
    await supplierPage.locator('#unusualCapacity').selectOption('no');
    await supplierPage.locator('#intermediary').selectOption('no');
    await supplierPage.locator('#accuracyDeclaration').check();
    await supplierPage.locator('#screeningConsent').check();
    await supplierPage.locator('#submit-button').click();
    await supplierPage.getByRole('heading', { name: 'Thank you — your application was submitted' }).waitFor();
    if (supplierReviewRequests !== 0) throw new Error('Supplier UI requested verification before submission.');
    if (screenshotDir) await supplierPage.screenshot({ path: join(screenshotDir, `flo-supplier-thank-you-${viewport.width}.png`), fullPage: true });
    const supplierOverflow = await supplierPage.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (supplierOverflow) throw new Error(`Supplier Onboarding UI overflows at ${viewport.width}px`);
    await supplierContext.close();
    console.log(`Supplier Onboarding v1 UI passed at ${viewport.width}px`);

    const genericContext = await browser.newContext({ viewport });
    const workflowSchema = { schema_version: '1.0.0', name: 'Supplier profile', tokens: { primary_color: '#064b79' },
      stages: [{ id: 'identity', title: 'Business identity', fields: [
        { id: 'business_name', label: 'Registered business name', type: 'text', required: true }], documents: [], declarations: [] },
      { id: 'declaration', title: 'Declaration', fields: [], documents: [], declarations: [
        { id: 'accuracy', label: 'I confirm the information is accurate', required: true }] }] };
    let genericDraft = {}; let genericDeclarations = {};
    await genericContext.route('**/flo/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = route.request().postDataJSON?.() || {};
      let response = {};
      if (path.endsWith('/session')) response = { application_id: appId, csrf_token: 'token' };
      else if (path.endsWith('/application')) response = { application: { application_id: appId, flow_id: 'flow-example',
        template_version: '1.0.0', application_revision: 1, status: 'in_progress', presentation: workflowSchema,
        draft: genericDraft, declarations: genericDeclarations, documents: [] } };
      else if (path.endsWith('/draft')) { genericDraft = data; response = { draft: data }; }
      else if (path.endsWith('/declarations')) { genericDeclarations = data; response = { declarations: data }; }
      else if (path.endsWith('/submit')) response = { application_id: appId, status: 'submitted' };
      await route.fulfill({ status: path.endsWith('/submit') ? 202 : 200,
        contentType: 'application/json', body: JSON.stringify(response) });
    });
    const genericPage = await genericContext.newPage();
    await genericPage.goto(`${base}/f/generic-token-abcdefghijklmnopqrstuvwxyz0123456789`);
    await genericPage.getByRole('heading', { name: 'Supplier profile' }).waitFor();
    await genericPage.getByLabel(/Registered business name/).fill('Aetherix Systems FZCO');
    await genericPage.getByRole('button', { name: 'Save and continue' }).click();
    await genericPage.getByLabel(/I confirm the information is accurate/).check();
    await genericPage.getByRole('button', { name: 'Submit application' }).click();
    await genericPage.getByRole('heading', { name: 'Application received' }).waitFor();
    if (await genericPage.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error(`Generic supplier UI overflows at ${viewport.width}px`);
    await genericContext.close();
    console.log(`Generic Flo supplier UI passed at ${viewport.width}px`);

    const workflowContext = await browser.newContext({ viewport });
    await workflowContext.route('**/portal/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let response = {};
      if (path === '/portal/api/auth/session') response = { account: { client_name: 'Buyer', email: 'buyer@example.com' }, csrf_token: 'token' };
      else if (path === '/portal/api/entitlements') response = { allowed_modules: ['flo'], available_modules: ['flo'] };
      else if (path === '/portal/api/flo/status') response = { enabled: true, workflow_platform_enabled: true };
      else if (path === '/portal/api/flo/workflows') response = { workflows: [{ flow_id: 'flow-example', name: 'Supplier profile',
        lifecycle: 'active', published_version: '1.0.0', owner_workspace_id: null }] };
      else if (path === '/portal/api/flo/workflows/catalog') response = { checks: [{ id: 'entity-aml',
        label: 'Business AML', description: 'Screen business', required_fields: ['business_name'], required_documents: [] }] };
      else if (path.endsWith('/definition')) response = { schema: workflowSchema, version: '1.0.0' };
      else if (path === '/portal/api/flo/workflows/validate') response = { valid: true, presentation: workflowSchema, issues: [] };
      else if (path.endsWith('/settings')) response = { settings: { enabled: true, brand_name: 'Buyer' } };
      else if (path.endsWith('/email-templates')) response = { templates: { receipt: { subject: 'Received', body: 'Thank you' } }, version: 1 };
      else if (path.endsWith('/smtp')) response = { smtp: { enabled: false, configured: false } };
      else if (path.endsWith('/copy')) response = { workflow: { flow_id: 'flow-copy', name: 'Supplier profile copy',
        lifecycle: 'draft', published_version: null, owner_workspace_id: 'a'.repeat(16),
        source_flow_id: 'flow-example', source_version: '1.0.0', draft_revision: 1, draft: workflowSchema } };
      else if (path.endsWith('/draft')) response = { workflow: { flow_id: 'flow-copy', name: 'Supplier profile copy',
        lifecycle: 'draft', published_version: null, owner_workspace_id: 'a'.repeat(16),
        draft_revision: 1, draft: workflowSchema } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    const workflowPage = await workflowContext.newPage();
    await workflowPage.goto(`${base}/workflows`);
    await workflowPage.getByRole('heading', { name: 'Workflows', exact: true }).waitFor();
    await workflowPage.locator('body.portal-ready').waitFor();
    await workflowPage.getByRole('button', { name: /Supplier profile.*flow-example/ }).click();
    await workflowPage.getByRole('button', { name: 'Copy to my workspace' }).waitFor();
    const workflowOverflow = await workflowPage.evaluate(() => ({ width: document.documentElement.scrollWidth,
      viewport: innerWidth, elements: [...document.querySelectorAll('body *')]
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 1
          && getComputedStyle(element).visibility !== 'hidden')
        .slice(0, 8).map((element) => `${element.tagName.toLowerCase()}#${element.id}.${element.className}`) }));
    if (workflowOverflow.width > workflowOverflow.viewport)
      throw new Error(`Workflows UI overflows at ${viewport.width}px: ${JSON.stringify(workflowOverflow)}`);
    await workflowContext.close();
    console.log(`Flo Workflows UI passed at ${viewport.width}px`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
