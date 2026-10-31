(() => {
  const byId = (id) => document.getElementById(id);
  const endpoint = '/service/dubai_ejari_verification';
  let certificateUrl = '';
  let activeKey = '';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  byId('copy-endpoint').addEventListener('click', () => navigator.clipboard.writeText(`https://api.ai7uae.com${endpoint}`));
  byId('ejari-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = byId('ejari-submit');
    const error = byId('ejari-error');
    const status = byId('ejari-status');
    const contract = byId('ejari-contract').value.trim();
    const dewa = byId('ejari-dewa').value.trim();
    const file = byId('ejari-file').files[0];
    error.textContent = '';
    if (!file && (!/^\d{14,17}$/.test(contract) || !/^\d{8,11}$/.test(dewa))) {
      error.textContent = 'Enter both numbers, or upload an Ejari PDF.';
      return;
    }
    activeKey = byId('ejari-api-key').value.trim();
    button.disabled = true;
    certificateUrl = '';
    byId('ejari-download').hidden = true;
    byId('ejari-summary').hidden = true;
    status.textContent = 'Submitting…';
    try {
      const headers = { authorization: `Bearer ${activeKey}`, 'idempotency-key': crypto.randomUUID() };
      let body;
      if (file) {
        body = new FormData();
        body.append('ejari_file', file);
        if (contract) body.append('contract_number', contract);
        if (dewa) body.append('dewa_number', dewa);
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify({ contract_number: contract, dewa_number: dewa });
      }
      const accepted = await fetch(endpoint, { method: 'POST', headers, body });
      const receipt = await accepted.json();
      if (!accepted.ok) throw new Error(receipt.error || receipt.reasonCode || 'Submission failed.');
      status.textContent = 'Processing…';
      let result;
      for (let attempt = 0; attempt < 120; attempt++) {
        await sleep(3000);
        const response = await fetch(receipt.resultUrl, { headers: { authorization: `Bearer ${activeKey}` } });
        const data = await response.json();
        if (response.status === 202) { status.textContent = `Processing… ${data.status || ''}`; continue; }
        if (!response.ok) throw new Error(data.error || data.reasonCode || 'Result unavailable.');
        result = data;
        break;
      }
      if (!result) throw new Error(`Still processing. Save job ID ${receipt.jobId} and poll its result URL.`);
      status.textContent = result.status.replaceAll('_', ' ');
      const summary = byId('ejari-summary');
      summary.replaceChildren();
      for (const [label, value] of [
        ['Outcome', result.status], ['DLD checked', result.source?.checkedAt],
        ['Contract number', result.contractNumber], ['DEWA premise', result.dewaNumber],
        ['Fields compared', result.comparison?.compared_fields], ['Differences', result.comparison?.different_fields?.join(', ') || 'None reported']
      ]) {
        const item = document.createElement('div');
        const heading = document.createElement('strong'); heading.textContent = label;
        const detail = document.createElement('p'); detail.textContent = value == null ? 'Unavailable' : String(value);
        item.append(heading, detail); summary.append(item);
      }
      summary.hidden = false;
      byId('ejari-json').textContent = JSON.stringify(result, null, 2);
      certificateUrl = result.certificateUrl || '';
      byId('ejari-download').hidden = !certificateUrl;
    } catch (problem) { error.textContent = problem.message || 'Verification failed.'; status.textContent = 'Could not complete'; }
    finally { button.disabled = false; }
  });
  byId('ejari-download').addEventListener('click', async () => {
    if (!certificateUrl) return;
    const response = await fetch(certificateUrl, { headers: { authorization: `Bearer ${activeKey}` } });
    if (!response.ok) { byId('ejari-error').textContent = 'Certificate download is unavailable.'; return; }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = 'ejari-dld-certificate.pdf'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
