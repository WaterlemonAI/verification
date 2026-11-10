import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseWorkflowSchema } from '../lib/flows/template-schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = {
  '/admin': 'admin-site/index.html', '/admin/admin.js': 'admin-site/admin.js', '/admin/admin.css': 'admin-site/admin.css',
  '/workflows': 'api-site/flo-workflows.html', '/flo-workflows.js': 'api-site/flo-workflows.js',
  '/flo-workflows.css': 'api-site/flo-workflows.css', '/api.css': 'api-site/api.css',
  '/portal-auth.js': 'api-site/portal-auth.js', '/flo-builder.js': 'api-site/flo-builder.js',
  '/flo-builder-model.js': 'api-site/flo-builder-model.js', '/flo-builder.css': 'api-site/flo-builder.css',
  '/flo-schema-view.js': 'flow-site/renderer/schema-view.js',
  '/flo-sortable.min.js': 'node_modules/sortablejs/Sortable.min.js',
  '/f/generic-token-abcdefghijklmnopqrstuvwxyz0123456789': 'flow-site/renderer/index.html',
  '/assets/renderer/app.js': 'flow-site/renderer/app.js',
  '/assets/renderer/schema-view.js': 'flow-site/renderer/schema-view.js',
  '/assets/renderer/styles.css': 'flow-site/renderer/styles.css'
};
const mime = (path) => path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html';
const server = createServer((req, res) => { const path = new URL(req.url, 'http://localhost').pathname;
  const file = files[path]; if (!file) { res.writeHead(404); res.end(); return; }
  const bytes = readFileSync(join(root, file)); res.writeHead(200, { 'content-type': mime(file), 'content-length': bytes.length }); res.end(bytes); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()) });
const initial = { schema_version: '1.0.0', name: 'Supplier profile',
  stages: [{ id: 'identity', title: 'Business identity', description: 'Provide legal details.', fields: [
    { id: 'business_name', label: 'Registered business name', type: 'text', required: true },
    { id: 'entity_type', label: 'Entity type', type: 'select', options: ['Company', 'Individual'], required: true },
    { id: 'licence_number', label: 'Licence number', type: 'text', required: true,
      show_if: { field: 'entity_type', equals: 'Company' } },
    { id: 'email', label: 'Business email', type: 'email', required: false },
    { id: 'website_url', label: 'Website', type: 'url', required: false },
    { id: 'start_date', label: 'Start date', type: 'date', required: false },
    { id: 'activities', label: 'Activities', type: 'textarea', required: false },
    { id: 'staff_count', label: 'Staff count', type: 'number', required: false },
    { id: 'stakeholders', label: 'Stakeholders', type: 'people', required: false }],
  documents: [{ id: 'trade_licence', label: 'Trade licence', required: true }],
  declarations: [{ id: 'accurate', label: 'I confirm these details are accurate', required: true }] }],
  checks: ['uae-trade-licence'], report_sections: ['Business identity'], tokens: { primary_color: '#064b79' } };
const check = { id: 'uae-trade-licence', label: 'UAE trade licence', description: 'Verify name and licence.',
  required_fields: ['business_name', 'licence_number'], required_documents: ['trade_licence'] };
let platformSchema = structuredClone(initial), ownedSchema = null, adminRevision = 1, orgRevision = 1;
let adminPublished = false, orgPublished = false, validationCalls = 0, caseCalls = 0;
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width === 390 }); const errors = [];
    const pages = [];
    await context.route('**/admin/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname; const method = route.request().method();
      const data = route.request().postDataJSON?.() || {}; let response = {};
      if (path === '/admin/api/auth/status') response = { configured: true };
      else if (path === '/admin/api/auth/session') response = { account: { email: 'admin@example.com' }, csrf_token: 'csrf' };
      else if (path === '/admin/api/integrations') response = { integrations: [] };
      else if (path === '/admin/api/customers') response = { customers: [] };
      else if (path === '/admin/api/flows/catalog') response = { checks: [check] };
      else if (path === '/admin/api/flows/validate') { response = diagnoseWorkflowSchema(data.schema); validationCalls++; }
      else if (path === '/admin/api/flows' && method === 'GET') response = { templates: [], workflow_platform_enabled: true,
        workflows: adminPublished ? [{ flow_id: 'flow-platform', name: platformSchema.name, lifecycle: 'active',
          published_version: '1.0.0', active_organisation_count: 1 }] : [] };
      else if (path === '/admin/api/flows' && method === 'POST') { platformSchema = data.schema; response = { workflow: {
        flow_id: 'flow-platform', name: data.schema.name, draft: platformSchema, lifecycle: 'draft', draft_revision: adminRevision,
        published_version: null } }; }
      else if (path.endsWith('/draft') && method === 'GET') response = { workflow: { flow_id: 'flow-platform',
        name: platformSchema.name, draft: platformSchema, lifecycle: adminPublished ? 'active' : 'draft',
        draft_revision: adminRevision, published_version: adminPublished ? '1.0.0' : null } };
      else if (path.endsWith('/draft') && method === 'PATCH') { platformSchema = data.schema; adminRevision++;
        response = { workflow: { flow_id: 'flow-platform', name: platformSchema.name, draft: platformSchema,
          lifecycle: 'draft', draft_revision: adminRevision } }; }
      else if (path.endsWith('/publish')) { adminPublished = true; response = { workflow: { flow_id: 'flow-platform',
        name: platformSchema.name, draft: platformSchema, lifecycle: 'active', draft_revision: adminRevision,
        published_version: '1.0.0' } }; }
      else if (path.endsWith('/assignments')) response = method === 'GET' ? { assignments: [] } : { assignment: { state: 'active' } };
      else response = { configuration: {} };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await context.route('**/portal/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname; const method = route.request().method();
      const data = route.request().postDataJSON?.() || {}; let response = {};
      if (path === '/portal/api/auth/session') response = { account: { client_name: 'Buyer', email: 'buyer@example.com' }, csrf_token: 'csrf' };
      else if (path === '/portal/api/entitlements') response = { allowed_modules: ['flo'], available_modules: ['flo'] };
      else if (path === '/portal/api/flo/status') response = { enabled: true, workflow_platform_enabled: true };
      else if (path === '/portal/api/flo/workflows') response = { workflows: [
        { flow_id: 'flow-platform', name: platformSchema.name, lifecycle: 'active', published_version: '1.0.0', owner_workspace_id: null },
        ...(ownedSchema ? [{ flow_id: 'flow-owned', name: ownedSchema.name, lifecycle: orgPublished ? 'active' : 'draft',
          published_version: orgPublished ? '1.0.0' : null, owner_workspace_id: 'a'.repeat(16), draft_revision: orgRevision }] : [])] };
      else if (path === '/portal/api/flo/workflows/catalog') response = { checks: [check] };
      else if (path === '/portal/api/flo/workflows/validate') { response = diagnoseWorkflowSchema(data.schema); validationCalls++; }
      else if (path.endsWith('/definition')) response = { schema: platformSchema, version: '1.0.0' };
      else if (path.endsWith('/copy')) { ownedSchema = structuredClone(platformSchema); response = { workflow: { flow_id: 'flow-owned',
        name: ownedSchema.name, draft: ownedSchema, lifecycle: 'draft', published_version: null,
        owner_workspace_id: 'a'.repeat(16), source_flow_id: 'flow-platform', draft_revision: orgRevision } }; }
      else if (path.endsWith('/draft') && method === 'GET') response = { workflow: { flow_id: 'flow-owned',
        name: ownedSchema.name, draft: ownedSchema, lifecycle: orgPublished ? 'active' : 'draft',
        published_version: orgPublished ? '1.0.0' : null, owner_workspace_id: 'a'.repeat(16), draft_revision: orgRevision } };
      else if (path.endsWith('/draft') && method === 'PATCH') { ownedSchema = data.schema; orgRevision++;
        response = { workflow: { flow_id: 'flow-owned', name: ownedSchema.name, draft: ownedSchema,
          owner_workspace_id: 'a'.repeat(16), draft_revision: orgRevision } }; }
      else if (path.endsWith('/publish')) { orgPublished = true; response = { workflow: { flow_id: 'flow-owned',
        name: ownedSchema.name, draft: ownedSchema, lifecycle: 'active', published_version: '1.0.0',
        owner_workspace_id: 'a'.repeat(16), draft_revision: orgRevision } }; }
      else if (path.endsWith('/settings')) response = { settings: { enabled: true, brand_name: 'Buyer' } };
      else if (path.endsWith('/email-templates')) response = { templates: { receipt: { subject: 'Received', body: 'Thank you' } }, version: 1 };
      else if (path.endsWith('/smtp')) response = { smtp: { enabled: false, configured: false } };
      else { caseCalls++; response = { error: 'Unexpected route' }; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await context.route('**/flo/api/**', async (route) => { caseCalls++; const path = new URL(route.request().url()).pathname;
      const response = path.endsWith('/session') ? { application_id: '11111111-1111-4111-8111-111111111111', csrf_token: 'csrf' }
        : { application: { application_id: '11111111-1111-4111-8111-111111111111', status: 'in_progress',
          presentation: ownedSchema || platformSchema, draft: {}, documents: [], declarations: {} } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }); });
    const admin = await context.newPage(); pages.push(admin); admin.on('pageerror', (error) => errors.push(`admin: ${error.message}`));
    admin.on('dialog', (dialog) => dialog.accept()); await admin.goto(`${base}/admin`);
    await admin.locator('#app-view').waitFor({ state: 'visible' });
    await admin.locator('[data-view="flo"]').click(); await admin.locator('#flo-workflow-manager').waitFor({ state: 'visible' });
    await admin.locator('#flo-workflow-new').click(); await admin.locator('.flo-builder').waitFor();
    await admin.locator('#flo-builder-root .flo-builder-tabs').getByRole('button', { name: 'JSON' }).click();
    await admin.getByRole('button', { name: 'Advanced edit' }).click();
    await admin.locator('.flo-json-panel textarea').fill(JSON.stringify({ ...initial,
      stages: [{ ...initial.stages[0], title: '<img src=x onerror=alert(1)>' }] }));
    await admin.getByRole('button', { name: 'Apply JSON' }).click();
    await admin.locator('.flo-builder-issues li').waitFor();
    await admin.getByRole('button', { name: 'Cancel JSON edits' }).click();
    await admin.getByRole('button', { name: 'Advanced edit' }).click();
    await admin.locator('.flo-json-panel textarea').fill(JSON.stringify(initial));
    await admin.getByRole('button', { name: 'Apply JSON' }).click();
    await admin.getByText('JSON applied to the builder.').waitFor();
    await admin.locator('#flo-builder-root .flo-builder-tabs').getByRole('button', { name: 'Builder' }).click();
    await admin.locator('#flo-builder-root .flo-palette').getByRole('button', { name: '+ Stage' }).click();
    await admin.locator('#flo-builder-root .flo-palette').getByRole('button', { name: '+ Field' }).click();
    await admin.locator('#flo-builder-root .flo-stage').last().locator('.flo-drag').first().focus();
    await admin.keyboard.press('ArrowUp'); await admin.keyboard.press('ArrowDown');
    if (!await admin.evaluate(() => document.activeElement?.classList.contains('flo-drag')))
      throw new Error('Keyboard reorder did not retain focus on the drag handle.');
    const firstField = admin.locator('#flo-builder-root [data-flo-id="business_name"] .flo-drag');
    const secondField = admin.locator('#flo-builder-root [data-flo-id="entity_type"] .flo-drag');
    await firstField.scrollIntoViewIfNeeded(); await secondField.scrollIntoViewIfNeeded();
    if (viewport.width === 390) {
      const source = await secondField.boundingBox(), target = await firstField.boundingBox();
      const cdp = await context.newCDPSession(admin);
      const from = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
      const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
        touchPoints: [{ x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await secondField.dragTo(firstField);
    await admin.waitForFunction(() => document.querySelector('#flo-builder-root .flo-stage .flo-item-list .flo-item')?.dataset.floId === 'entity_type');
    await admin.locator('#flo-builder-root [data-flo-id="entity_type"]').getByRole('button', { name: 'Move Entity type down' }).click();
    await admin.locator('#flo-builder-root .flo-builder-tabs').getByRole('button', { name: 'Preview' }).click();
    await admin.locator('.flo-preview form').waitFor();
    if (await admin.locator('.flo-preview input[type=file]:not([disabled])').count()) throw new Error('Preview can upload.');
    let previewLabels = await admin.locator('.flo-preview .field>span').allTextContents();
    await admin.locator('#flo-workflow-save').click(); await admin.getByText('Draft saved.', { exact: true }).waitFor();
    if (JSON.stringify(platformSchema).includes('undefined')) throw new Error('Invalid saved schema');
    await admin.locator('#flo-workflow-publish').click(); await admin.getByText('Published 1.0.0.').waitFor();
    const org = await context.newPage(); pages.push(org); org.on('pageerror', (error) => errors.push(`org: ${error.message}`));
    org.on('dialog', (dialog) => dialog.accept()); await org.goto(`${base}/workflows`);
    await org.locator('body.portal-ready').waitFor();
    await org.getByRole('button', { name: /flow-platform/ }).click();
    await org.locator('.flo-builder').waitFor();
    if (await org.getByRole('button', { name: 'Builder', exact: true }).count()) throw new Error('Assigned template is editable.');
    await org.getByRole('button', { name: 'Copy to my workspace' }).click();
    await org.getByRole('button', { name: 'Builder', exact: true }).waitFor();
    await org.locator('.flo-builder .flo-palette').getByRole('button', { name: '+ Document' }).click();
    await org.getByRole('button', { name: 'Save draft' }).click(); await org.getByText(/Draft saved, revision/).waitFor();
    await org.getByRole('button', { name: 'Publish version' }).click(); await org.getByText('Published 1.0.0.').waitFor();
    await org.locator('.flo-builder-tabs').getByRole('button', { name: 'Preview' }).click();
    await org.locator('.flo-preview .field').first().waitFor();
    await org.locator('.flo-preview [name="entity_type"]').selectOption('Company');
    await org.locator('.flo-preview [name="licence_number"]').waitFor();
    previewLabels = await org.locator('.flo-preview .field>span').allTextContents();
    const supplier = await context.newPage(); pages.push(supplier);
    supplier.on('pageerror', (error) => errors.push(`supplier: ${error.message}`));
    await supplier.goto(`${base}/f/generic-token-abcdefghijklmnopqrstuvwxyz0123456789`);
    await supplier.locator('#form .field').first().waitFor();
    await supplier.locator('#form [name="entity_type"]').selectOption('Company');
    await supplier.locator('#form [name="licence_number"]').waitFor();
    const supplierLabels = await supplier.locator('#form .field>span').allTextContents();
    if (JSON.stringify(previewLabels) !== JSON.stringify(supplierLabels))
      throw new Error(`Preview and supplier labels differ: ${JSON.stringify(previewLabels)} vs ${JSON.stringify(supplierLabels)}`);
    await admin.locator('#flo-workflow-new').click();
    await admin.locator('#flo-builder-root .flo-palette').getByRole('button', { name: '+ Stage' }).click();
    if (viewport.width === 1440) {
      const stages = admin.locator('#flo-builder-root .flo-stage-list > .flo-stage');
      await stages.nth(1).locator(':scope > .flo-item > .flo-drag').scrollIntoViewIfNeeded();
      const source = await stages.nth(1).locator(':scope > .flo-item > .flo-drag').boundingBox();
      const target = await stages.first().boundingBox();
      await admin.mouse.move(source.x + 15, source.y + source.height / 2);
      await admin.mouse.down();
      await admin.mouse.move(target.x + 15, target.y + 10, { steps: 18 });
      await admin.mouse.up();
      const order = await admin.locator('#flo-builder-root .flo-stage-list > .flo-stage > .flo-item')
        .evaluateAll((rows) => rows.map((row) => row.dataset.floId));
      if (order[0] !== 'new_stage') { const sortable = await admin.evaluate(() => {
        const instance = window.Sortable?.get(document.querySelector('.flo-stage-list'));
        return { exists: Boolean(instance), draggable: instance?.option('draggable'), handle: instance?.option('handle'),
          announcement: document.querySelector('.flo-builder-announcement')?.textContent };
      }); throw new Error(`Stage drag did not reorder: ${order.join(', ')} ${JSON.stringify(sortable)}`); }
    }
    await admin.locator('#flo-builder-root .flo-palette').getByRole('button', { name: '+ Field' }).click();
    await admin.locator('#flo-workflow-save').click(); await admin.getByText('Draft saved.', { exact: true }).waitFor();
    await admin.locator('#flo-workflow-publish').click(); await admin.getByText('Published 1.0.0.').waitFor();
    if (caseCalls !== 2 * (viewport.width === 390 ? 2 : 1)) throw new Error('Authoring preview called a case API.');
    for (const page of pages.slice(0, 2)) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 1) { const offenders = await page.evaluate(() => [...document.querySelectorAll('body *')]
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 10)
        .slice(0, 12).map((element) => `${element.tagName}.${element.className || ''}:${Math.round(element.getBoundingClientRect().right)}:${element.scrollWidth}/${element.clientWidth}:${element.textContent.slice(0, 70)}`));
        throw new Error(`${page.url()} overflows ${viewport.width}px by ${overflow}px: ${offenders.join(', ')}`); }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`Flo builder admin, organisation and supplier preview passed at ${viewport.width}px`);
    await context.close();
  }
  if (validationCalls < 4 || !adminPublished || !orgPublished) throw new Error('Authoring journey incomplete.');
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
