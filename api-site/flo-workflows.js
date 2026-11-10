(() => {
  const $ = (id) => document.getElementById(id); let csrf = ''; let selected = null; let builder = null;
  const node = (tag, value) => { const item = document.createElement(tag); item.textContent = value; return item; };
  async function call(path, method = 'GET', data) { const response = await fetch(path, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-ai7-csrf': csrf }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'Request failed'); return result; }
  function message(value) { $('message').textContent = value || ''; }
  async function list() { const { workflows } = await call('/portal/api/flo/workflows'); const container = $('list'); container.replaceChildren();
    if (!workflows.length) container.append(node('p', 'No workflows are assigned yet.'));
    for (const entry of workflows) { const button = node('button', ''); button.className = 'workflow-row';
      button.append(node('strong', entry.name), node('small', `${entry.flow_id} · ${entry.lifecycle} · ${entry.published_version || 'unpublished'}`));
      button.addEventListener('click', () => show(entry).catch((error) => message(error.message))); container.append(button); }
    return workflows; }
  async function show(entry, force = false) { if (!force && builder?.dirty && !window.confirm('Discard unsaved workflow edits?')) return;
    builder?.destroy(); builder = null; selected = entry; message(''); const area = $('detail'); area.replaceChildren(node('h2', entry.name),
    node('p', `ID ${entry.flow_id} · ${entry.lifecycle} · ${entry.published_version || 'draft'}`));
    if (entry.source_flow_id) area.append(node('p', `Copied from ${entry.source_flow_id} @ ${entry.source_version}`));
    const actions = node('div', ''); actions.className = 'workflow-actions'; area.append(actions);
    const button = (title, action) => { const item = node('button', title); item.type = 'button'; item.addEventListener('click', async () => {
      item.disabled = true; try { await action(); } catch (error) { message(error.message); } finally { item.disabled = false; } }); actions.append(item); };
    button('Copy to my workspace', async () => { if (builder?.dirty && !window.confirm('Discard unsaved workflow edits?')) return;
      const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/copy`, 'POST', {});
      await list(); await show(result.workflow, true); message('Private copy created. Edit and publish it when ready.'); });
    const { mountFloBuilder } = await import('/flo-builder.js');
    const catalog = (await call('/portal/api/flo/workflows/catalog')).checks || [];
    const editorRoot = node('div', ''); area.append(editorRoot);
    if (entry.owner_workspace_id) {
      const { workflow } = await call(`/portal/api/flo/workflows/${entry.flow_id}/draft`); selected = workflow;
      builder = mountFloBuilder(editorRoot, { schema: workflow.draft, checks: catalog,
        validate: (schema) => call('/portal/api/flo/workflows/validate', 'POST', { schema }) });
      let savePending = false;
      button('Save draft', async () => {
        if (savePending) return;
        savePending = true;
        try { const editor = builder; const target = selected; const schema = editor.getSchema();
          if (!await editor.validate()) return;
          if (editor !== builder || target !== selected || JSON.stringify(editor.getSchema()) !== JSON.stringify(schema))
            throw new Error('Workflow changed during validation. Review your edits and save again.');
          const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/draft`, 'PATCH',
            { schema, expected_revision: target.draft_revision });
          if (editor === builder && target === selected) {
            selected = result.workflow; editor.markSaved(schema);
            message(editor.dirty ? 'Draft saved. Newer edits remain unsaved.' : `Draft saved, revision ${selected.draft_revision}.`);
          }
        } catch (error) { message(error.message.includes('conflict')
          ? 'Draft changed elsewhere. Your edits remain here. Copy JSON, then reload and compare.' : error.message); }
        finally { savePending = false; }
      });
      button('Publish version', async () => {
        if (savePending) throw new Error('Wait for the draft save to complete.');
        if (builder.dirty) throw new Error('Save the latest changes before publishing.');
        if (!await builder.validate()) return;
        if (!window.confirm(`Publish a new immutable version? ${builder.summary()}`)) return;
        const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/publish`, 'POST',
          { expected_revision: selected.draft_revision });
        await list(); await show(result.workflow, true); message(`Published ${result.workflow.published_version}.`);
      });
      for (const state of ['active', 'paused', 'archived']) button(state === 'active' ? 'Start' : state === 'paused' ? 'Pause' : 'Archive', async () => {
        if (builder.dirty) throw new Error('Save or discard your edits first.');
        if (state === 'archived' && !window.confirm('Archive this workflow? Existing cases remain accessible.')) return;
        const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/lifecycle`, 'POST',
          { state, expected_revision: selected.draft_revision }); await list(); await show(result.workflow, true); message(`Workflow ${state}.`); });
    } else if (entry.published_version) {
      const { schema } = await call(`/portal/api/flo/workflows/${entry.flow_id}/definition`);
      area.append(node('p', 'Assigned platform template. Copy it to edit and publish for your organisation.'));
      builder = mountFloBuilder(editorRoot, { schema, checks: catalog, readOnly: true,
        validate: async () => ({ valid: true, issues: [] }) });
    }
    const { settings } = await call(`/portal/api/flo/workflows/${entry.flow_id}/settings`);
    const form = document.createElement('form'); form.className = 'workflow-settings'; area.append(node('h3', 'Branding and callback'), form);
    for (const [key, title] of Object.entries({ brand_name: 'Buyer name', primary_color: 'Primary colour',
      accent_color: 'Accent colour', support_url: 'Support URL', privacy_url: 'Privacy URL', callback_url: 'Callback URL',
      success_url: 'Success redirect', failure_url: 'Failure redirect' })) {
      const label = node('label', title); const input = document.createElement('input'); input.name = key; input.value = settings[key] || '';
      label.append(input); form.append(label); }
    const toggle = node('label', 'Enabled for new links'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    checkbox.name = 'enabled'; checkbox.checked = settings.enabled !== false; toggle.append(checkbox); form.append(toggle);
    const save = node('button', 'Save settings'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(form));
      data.enabled = checkbox.checked; const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/settings`, 'PUT', data);
      message(result.callback_signing_secret ? `Settings saved. Copy callback key ${result.signature_key_id}: ${result.callback_signing_secret}`
        : 'Settings saved for future applications.'); } catch (error) { message(error.message); } });
    const logoLabel = node('label', 'Buyer logo (PNG or JPEG, up to 1 MB)'); const logoInput = document.createElement('input');
    logoInput.type = 'file'; logoInput.accept = '.png,.jpg,.jpeg'; logoLabel.append(logoInput); area.append(logoLabel);
    const logoButton = node('button', 'Upload logo'); logoButton.type = 'button'; area.append(logoButton);
    logoButton.addEventListener('click', async () => { try { const file = logoInput.files?.[0];
      if (!file || file.size > 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a PNG or JPEG under 1 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      await call(`/portal/api/flo/workflows/${entry.flow_id}/logo`, 'POST', { mime_type: file.type, content_base64: btoa(binary) });
      message('Logo saved for future applications.'); } catch (error) { message(error.message); } });
    const emailSettings = await call(`/portal/api/flo/workflows/${entry.flow_id}/email-templates`);
    area.append(node('h3', 'Applicant email templates'));
    const templateCode = document.createElement('textarea'); templateCode.className = 'workflow-code';
    templateCode.value = JSON.stringify(emailSettings.templates, null, 2); templateCode.setAttribute('aria-label', 'Email templates JSON'); area.append(templateCode);
    const emailPreview = node('pre', 'Preview a template to inspect rendered text.'); emailPreview.className = 'workflow-preview'; area.append(emailPreview);
    const emailActions = node('div', ''); emailActions.className = 'workflow-actions'; area.append(emailActions);
    const kind = document.createElement('select'); kind.setAttribute('aria-label', 'Email type');
    for (const name of ['link', 'receipt', 'accepted', 'rejected', 'restart']) { const option = node('option', name); option.value = name; kind.append(option); }
    emailActions.append(kind);
    const previewButton = node('button', 'Preview email'); previewButton.type = 'button';
    previewButton.addEventListener('click', async () => { try { const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/email-preview`, 'POST',
      { kind: kind.value, templates: JSON.parse(templateCode.value) }); emailPreview.textContent = `${result.preview.subject}\n\n${result.preview.text}`;
    } catch (error) { message(error.message); } }); emailActions.append(previewButton);
    const saveEmail = node('button', 'Save email templates'); saveEmail.type = 'button';
    saveEmail.addEventListener('click', async () => { try { const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/email-templates`, 'PUT',
      { templates: JSON.parse(templateCode.value), expected_version: emailSettings.version });
      emailSettings.version = result.version; message(`Email templates saved as version ${result.version}.`);
    } catch (error) { message(error.message); } }); emailActions.append(saveEmail);
    const smtpState = await call(`/portal/api/flo/workflows/${entry.flow_id}/smtp`);
    const smtpConfig = smtpState.smtp;
    area.append(node('h3', 'Organisation SMTP'));
    area.append(node('p', smtpConfig.enabled ? smtpState.sender_domain_verified
      ? 'SPF, DKIM and DMARC records are present.' : 'Sender DNS is not ready; organisation SMTP will not send until SPF, DKIM and DMARC are present.'
      : 'Platform email is used.'));
    const smtpForm = document.createElement('form'); smtpForm.className = 'workflow-settings'; area.append(smtpForm);
    for (const [key, title] of Object.entries({ host: 'Public SMTP host', user: 'SMTP user', from_email: 'From email', from_name: 'From name',
      dkim_selector: 'DKIM selector' })) {
      const label = node('label', title); const input = document.createElement('input'); input.name = key; input.value = smtpConfig[key] || '';
      label.append(input); smtpForm.append(label); }
    const passwordLabel = node('label', 'SMTP password (write only)'); const password = document.createElement('input');
    password.type = 'password'; password.name = 'password'; password.autocomplete = 'new-password'; passwordLabel.append(password); smtpForm.append(passwordLabel);
    const smtpEnabledLabel = node('label', 'Use organisation SMTP'); const smtpEnabled = document.createElement('input');
    smtpEnabled.type = 'checkbox'; smtpEnabled.checked = smtpConfig.enabled === true; smtpEnabledLabel.append(smtpEnabled); smtpForm.append(smtpEnabledLabel);
    const smtpSave = node('button', 'Save SMTP'); smtpSave.type = 'submit'; smtpForm.append(smtpSave);
    smtpForm.addEventListener('submit', async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(smtpForm));
      data.enabled = smtpEnabled.checked; data.port = 465;
      const result = await call(`/portal/api/flo/workflows/${entry.flow_id}/smtp`, 'PUT', data);
      password.value = ''; message(result.smtp.enabled ? 'SMTP saved. Verify SPF, DKIM and DMARC before live use.' : 'Platform email fallback enabled.');
    } catch (error) { message(error.message); } });
    const sendTest = node('button', 'Send test to my sign-in email'); sendTest.type = 'button';
    sendTest.addEventListener('click', async () => { try { await call(`/portal/api/flo/workflows/${entry.flow_id}/test-email`, 'POST', {});
      message('Test email sent. Check your inbox and sender authentication.'); } catch (error) { message(error.message); } }); area.append(sendTest);
  }
  async function start() { try { csrf = (await call('/portal/api/auth/session')).csrf_token; await list(); } catch (error) { message(error.message); } }
  start();
})();
