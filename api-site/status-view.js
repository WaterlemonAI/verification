(() => {
  const pending = new Set(['pending', 'queued', 'running', 'processing', 'submitted']);
  const failed = new Set(['error', 'failed', 'expired', 'unavailable', 'could_not_complete']);
  const safe = (value) => typeof value === 'string' ? value.slice(0, 160) : '';
  const parse = (value) => { try { return JSON.parse(value); } catch { return null; } };
  function describe(service, body, statusText) {
    const status = safe(body?.status || body?.state || '').toLowerCase();
    const text = safe(statusText).toLowerCase();
    if (/^ready$/.test(text)) return ['Awaiting result', 'Submit a request to see its progress and source result.'];
    if (failed.has(status) || /request error|connection error|could not complete|^(?:http )?[45]\d\d/.test(text))
      return ['Could not complete', 'Review the error and source response before retrying.'];
    if (pending.has(status) || service === 'forms' && status === 'accepted'
      || /submitting|uploading|collecting|searching|processing|queued|still processing/.test(text))
      return [status === 'queued' || service === 'forms' ? 'Queued' : 'Processing',
        service === 'forms' ? 'Await the signed callback for the final result. There is no live status endpoint.'
          : 'This request has not reached a final result. Keep the result URL or job ID if supplied.'];
    if (service === 'forms') return ['Submission receipt',
      'The Form was queued. Await the signed callback; an HTTP success is not a completed verification.'];
    if (service === 'ocr') return ['Extraction result',
      'Compare the extracted values with the source document. Extraction does not verify authenticity.'];
    if (service === 'entity-search') {
      if (body?.profiles_success === false || body?.apc_success === false || status === 'partial')
        return ['Coverage incomplete', 'Review unavailable sources and candidate profiles.'];
      const profiles = body?.data?.profiles;
      if (Array.isArray(profiles)) {
        if (profiles.length) return ['Candidates found', 'Review each candidate and source coverage before attributing a match.'];
        if (body.profiles_success === true && body.apc_success === true)
          return ['No candidates in completed coverage', 'This result applies only to the completed sources.'];
        return ['Coverage unknown', 'No candidates are listed, but the response does not confirm that all searches completed.'];
      }
    }
    if (service === 'adverse-media' || service === 'merchant-screening') {
      if (status === 'partial' || body?.coverage?.complete === false || body?.summary?.decision_eligible === false)
        return ['Review required', 'Coverage or decision eligibility is incomplete; inspect the source results.'];
      const hits = service === 'adverse-media' ? body?.results : body?.findings;
      if (Array.isArray(hits)) {
        if (hits.length) return ['Findings to review', 'Inspect source evidence and coverage before making a decision.'];
        const complete = status === 'completed' && body?.summary?.decision_eligible === true
          && (service === 'adverse-media' ? body?.coverage?.complete === true : true);
        return complete
          ? ['No material findings in completed coverage', 'This is not a legal or commercial clearance.']
          : ['Coverage unknown', 'No findings are listed, but the response does not confirm completed screening.'];
      }
    }
    if (service === 'iban') {
      const match = body?.data?.results;
      if (match) return ['Provider match result',
        `Result: ${safe(match.result) || 'unknown'} · bank ${match.bank ? 'reported' : 'not reported'} · account owner ${match.completeName ? 'reported' : 'not reported'}. Review all components.`];
    }
    if (service === 'trade-licence') {
      const licence = body?.uae_tl_verification || body?.trade_licence_verification_api;
      if (licence) return ['Licence data returned',
        `Provider status: ${safe(licence.license_status) || 'unknown'}. Compare registered name, number and expiry with the document.`];
    }
    if (service === 'bank-statement-analysis' && status === 'completed') return ['Analysis complete',
      body?.decisionEligible === false ? 'Decision data is incomplete; review findings and coverage.'
        : 'Review coverage, account data and findings. Analysis is not a credit approval.'];
    if (service === 'ejari' && status) return ['Provider result received',
      `Provider status: ${status.replaceAll('_', ' ')}. Compare fields and review any differences.`];
    if (body && typeof body === 'object' && !Array.isArray(body)) return ['Response received — review result',
      'The HTTP response completed. Inspect the provider outcome and coverage before deciding.'];
    if (/^(?:http )?2\d\d/.test(text)) return ['Response received — review result',
      'The HTTP response completed. Inspect the provider outcome and coverage before deciding.'];
    return ['Awaiting result', 'Submit a request to see its progress and source result.'];
  }
  function attach(service, { statusId = 'response-status', jsonId = 'response-json', panelId = 'check-state' } = {}) {
    const status = document.getElementById(statusId);
    const raw = document.getElementById(jsonId);
    const panel = document.getElementById(panelId);
    if (!status || !raw || !panel) return;
    let queued = false;
    const update = () => {
      queued = false;
      const [title, detail] = describe(service, parse(raw.textContent), status.textContent);
      panel.replaceChildren();
      const heading = document.createElement('strong'); heading.textContent = title;
      const note = document.createElement('span'); note.textContent = detail;
      panel.append(heading, note);
      panel.dataset.state = /incomplete|unknown|review|could not/i.test(title) ? 'review'
        : /queued|processing|awaiting/i.test(title) ? 'pending' : 'result';
    };
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(update); } };
    new MutationObserver(schedule).observe(status, { childList: true, characterData: true, subtree: true });
    new MutationObserver(schedule).observe(raw, { childList: true, characterData: true, subtree: true });
    update();
  }
  window.KYCStatusView = Object.freeze({ attach, describe });
})();
