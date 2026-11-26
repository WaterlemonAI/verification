import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import forge from 'node-forge';
import { PDFDocument } from 'pdf-lib';
import { EnvironmentStore } from '../lib/api-store.mjs';
import { collectJevArchiveArticles } from '../lib/adverse-media-jev-archive-source.mjs';
import { validateJevIntegratedRequest } from '../lib/adverse-media-jev-integrated.mjs';
import { publicIncidentReport } from '../lib/adverse-media-incident-final.mjs';
import { generateSearchTransliterations } from '../lib/adverse-media-search-transliterations.mjs';
import { JEV_SCREENING_MODEL } from '../lib/adverse-media-jev-screening.mjs';

process.env.NODE_ENV = 'test';
process.env.ADVERSE_MEDIA_JEV_API_ENABLED = 'true';
process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN = 'jev-integrated-test-token-with-32-characters';
process.env.EVENT_REGISTRY_API_KEY = 'fake-event-registry-key';
process.env.MISTRAL_API_KEY = 'fake-summary-key';
const { createAppServer } = await import('../server.mjs');

const body = 'Authorities investigated Example Trading LLC for a specific fraud case. '.repeat(8);
const eventArticle = { uri: 'er-001', title: 'Example Trading LLC fraud investigation',
  url: 'https://news.example.org/fraud', body,
  source: { title: 'Example News' }, dateTimePub: '2026-11-20T09:00:00Z' };
const archiveArticle = { recordId: 'archive-001', title: eventArticle.title,
  url: eventArticle.url, source: 'news.example.org', publishedAt: eventArticle.dateTimePub };
let newsRows = [
  { title: eventArticle.title, url: eventArticle.url,
    description: 'Example Trading LLC faces a fraud investigation.' },
  { title: 'Example Trading LLC fraud case update', url: 'https://other.example.org/fraud-update',
    description: 'Authorities gave an update on the same fraud case involving Example Trading LLC.' },
  { title: 'Unrelated company faces fraud investigation', url: 'https://other.example.org/unrelated',
    description: 'Example Trading LLC is mentioned only in an incidental search excerpt.' },
  { title: 'Example Trading LLC annual results', url: 'https://other.example.org/annual-results',
    description: 'Example Trading LLC published ordinary annual results.' }
];
const calls = [];
const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const certificate = forge.pki.createCertificate();
certificate.publicKey = keys.publicKey;
certificate.serialNumber = '01';
certificate.validity.notBefore = new Date(Date.now() - 60_000);
certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
const qaSubject = [{ name: 'commonName', value: 'KYCProbe QA Test Signer' }];
certificate.setSubject(qaSubject);
certificate.setIssuer(qaSubject);
certificate.sign(keys.privateKey, forge.md.sha256.create());
const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certificate, 'qa-password',
  { algorithm: '3des' });
const incidentReportSigning = { p12Bytes: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
  passphrase: 'qa-password', name: 'KYCProbe QA Test Signer' };
let archiveRows = [archiveArticle, { recordId: 'archive-excluded',
  title: 'Example Trading LLC annual update', url: 'https://news.example.org/annual',
  source: 'news.example.org', publishedAt: eventArticle.dateTimePub }];
let eventStatus = 200;
let qaSourceGap = false;
const archiveSearch = async () => ({ complete: true, scan: { mode: 'v2_point_summary' },
  state: { coverage_start: '2026-10-01T00:00:00.000Z', coverage_end: '2026-11-26T23:45:00.000Z',
    ...(qaSourceGap ? { qa_source_gap: true } : {}) } });
const archivePage = async () => ({ rows: archiveRows, done: true, nextCursor: null });
const fetchImpl = async (url, options) => {
  const address = String(url);
  calls.push({ address, options });
  if (address === 'https://analytics.eventregistry.org/api/v1/extractArticleInfo')
    return Response.json({ title: eventArticle.title, urlCanonical: eventArticle.url,
      body: eventStatus === 204 ? 'short' : body, datetime: eventArticle.dateTimePub },
      { status: eventStatus === 204 ? 200 : eventStatus });
  if (address.includes('/res/v1/news/search')) return Response.json({ results: newsRows });
  if (address.includes('/res/v1/web/search')) return Response.json({});
  if (address === 'https://api.mistral.ai/v1/chat/completions') {
    const payload = JSON.parse(options.body);
    const variants = payload.response_format?.json_schema?.name === 'screening_name_word_variants';
    const name = variants ? JSON.parse(payload.messages[1].content).words.join(' ') : '';
    return Response.json({ model: 'ministral-3b-2512',
      choices: [{ message: { content: JSON.stringify(variants
        ? name === 'Arbaz Uddin'
          ? { ar_words: ['أرباز', 'الدين'], hi_words: ['अरबाज़', 'उद्दीन'] }
          : { ar_words: ['إكزامبل', 'تريدينغ', 'شركة'], hi_words: ['एग्ज़ाम्पल', 'ट्रेडिंग', 'कंपनी'] }
        : { theme: 'Example Trading fraud investigation' }) } }],
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 }
    });
  }
  if (address === 'https://api.typesafe.ai/v1/systemone') {
    const request = JSON.parse(options.body);
    if (request.questions.subject_association) {
      const neutral = request.state.article.title.includes('annual results');
      return Response.json({ model: JEV_SCREENING_MODEL,
      answers: { subject_association: { type: 'noul', noul: 0.99 },
        adverseness: { type: 'choice', choice: neutral ? 'non-adverse' : 'adverse', probabilities: {
          adverse: neutral ? 0.01 : 0.98, 'non-adverse': neutral ? 0.98 : 0.01, inconclusive: 0.01 } },
        relationship: { type: 'choice', choice: 'direct', probabilities: {
          direct: 0.98, indirect: 0.01, inconclusive: 0.01 } } } });
    }
    if (request.questions.specific_incident) return Response.json({ model: JEV_SCREENING_MODEL,
      answers: { specific_incident: { type: 'noul', noul: 0.97 } } });
    if (request.questions.same_incident) return Response.json({ model: JEV_SCREENING_MODEL,
      answers: { same_incident: { type: 'choice', choice: 'same', probabilities: {
        same: 0.96, different: 0.02, inconclusive: 0.02 } } } });
  }
  throw new Error(`unexpected_provider_url:${address}`);
};
const store = new EnvironmentStore();
let server;
let base;
before(async () => {
  await store.setMasterKey('adverse-media', 'fake-brave-key');
  await store.setMasterKey('adverse-media-jev', 'fake-jev-key');
  server = createAppServer({ store, fetchImpl, jevArchiveSearch: archiveSearch,
    jevArchivePage: archivePage, incidentReportSigning, startWorker: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise((resolve) => server.close(resolve)));

const input = { subject: { name: 'Example Trading LLC', entity_type: 'business', aliases: [] },
  adverse_profile: 'all', countries: [], date_from: '2026-11-01', date_to: '2026-11-25',
  max_articles: 2 };
const post = (payload, token = process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN) =>
  fetch(`${base}/internal/adverse-media-jev/integrated-test`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload) });
const reportPost = (payload) => fetch(`${base}/internal/adverse-media-advance/report-test`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.ADVERSE_MEDIA_JEV_SCREENING_TOKEN}`,
    'content-type': 'application/json' },
  body: JSON.stringify(payload)
});

test('archive rejects a request window beyond its committed watermark', async () => {
  const request = validateJevIntegratedRequest(input);
  let paged = false;
  await assert.rejects(() => collectJevArchiveArticles(request, {
    eventRegistryApiKey: 'fake-event-registry-key',
    archiveSearch: async () => ({ complete: true, scan: { mode: 'v2_point_summary' },
      state: { coverage_start: '2026-10-01T00:00:00.000Z',
        coverage_end: '2026-11-25T01:30:00.000Z' } }),
    archivePage: async () => { paged = true; return { rows: [], done: true }; }
  }), { message: 'archive_window_incomplete' });
  assert.equal(paged, false);
});

test('integrated request accepts 40 articles and rejects 41', () => {
  assert.equal(validateJevIntegratedRequest({ ...input, max_articles: 40 }).max_articles, 40);
  assert.throws(() => validateJevIntegratedRequest({ ...input, max_articles: 41 }),
    { message: 'invalid_integrated_request' });
  assert.throws(() => validateJevIntegratedRequest({ ...input,
    subject: { ...input.subject, transliterations: {
      ar: ['أرباز | site:example.com'], hi: [] } } }),
  { message: 'invalid_integrated_request' });
});

test('name generation retries a merged spelling and preserves input word boundaries', async () => {
  let attempts = 0;
  const result = await generateSearchTransliterations({ subject: {
    name: 'Arbaz Uddin', entity_type: 'individual', aliases: [] },
  apiKey: 'fake', fetchImpl: async () => {
    attempts += 1;
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      ar_words: ['أرباز', 'الدين'], hi_words: attempts === 1
        ? ['अर्बजुद्दीन'] : ['अरबाज़', 'उद्दीन']
    }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  } });
  assert.equal(attempts, 2);
  assert.deepEqual(result.transliterations.hi, ['अरबाज़ उद्दीन']);
  assert.equal(result.usage.total_tokens, 30);
});

test('live-source test route merges Event Registry and Brave, screens, groups, and returns no PDF', async () => {
  calls.length = 0;
  const response = await post(input);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.adverse_profile, 'all');
  assert.equal(result.policy_ids.length, 64);
  assert.equal(result.policy_evaluation_status, 'not_run');
  assert.equal(result.coverage.archive.postings_scanned, 2);
  assert.equal(result.coverage.archive.unique_shortlisted_urls, 1);
  assert.equal(result.coverage.archive.excluded_by_name_or_terms, 1);
  assert.equal(result.coverage.event_registry.calls, 2);
  assert.equal(result.coverage.event_registry.search_url_attempts, 1);
  assert.equal(result.coverage.event_registry.selected, 1);
  assert.equal(result.coverage.event_registry.body_selected, 1);
  assert.equal(result.coverage.event_registry.retained, 1);
  assert.equal(result.coverage.brave.selected, 2);
  assert.equal(result.coverage.brave.name_matched, 3);
  assert.equal(result.event_register.articles.length, 2);
  assert.equal(result.event_register.incidents.length, 1);
  assert.deepEqual(result.event_register.articles.map((item) => item.adverseness), ['adverse', 'adverse']);
  assert.deepEqual(result.event_register.articles.map((item) => item.relationship), ['direct', 'direct']);
  assert.equal(result.event_register.articles[0].incident_id,
    result.event_register.articles[1].incident_id);
  assert.deepEqual(result.event_register.articles[0].sources,
    ['gdelt_v2_archive', 'event_registry_extraction', 'brave_news']);
  assert.ok(result.event_register.articles[0].matched_term_ids.length > 0);
  assert.ok(result.event_register.articles[0].text_characters >= 300);
  assert.equal(result.event_register.articles[0].excerpt, newsRows[0].description);
  assert.equal(result.event_register.articles[0].jev_review.association_probability, 0.99);
  assert.equal(result.incident_review.eligibility_reviews.length, 2);
  assert.equal(result.incident_review.pair_reviews.length, 1);
  assert.equal(Object.hasOwn(result.event_register.articles[0], 'text'), false);
  assert.equal(result.report_generated, false);
  assert.equal(Object.hasOwn(result, 'report'), false);
  assert.equal(result.usage.event_registry_calls, 2);
  assert.equal(result.usage.brave_calls, 2);
  assert.equal(result.usage.jev_calls, 5);
  const erRequest = JSON.parse(calls.find((item) => item.address.includes('eventregistry.org')).options.body);
  assert.equal(erRequest.url, eventArticle.url);
  assert.ok(calls.every((item) => !item.address.includes('generativelanguage.googleapis.com')));
});

test('neutral articles stay in review and do not form incident groups', async () => {
  const response = await post({ ...input, max_articles: 3 });
  assert.equal(response.status, 200);
  const result = await response.json();
  const neutral = result.event_register.articles.find((item) => item.title.includes('annual results'));
  assert.equal(neutral.adverseness, 'non-adverse');
  assert.equal(neutral.incident_id, null);
  assert.equal(neutral.incident_reason, 'not_an_adverse_incident');
  assert.equal(result.coverage.adverse_grouping_candidates, 2);
  assert.equal(result.event_register.incidents.length, 1);
});

test('public report marks a QA source gap without naming its provider', async () => {
  const integrated = await (await post(input)).json();
  integrated.coverage.archive.snapshot.qa_source_gap = true;
  const report = publicIncidentReport(integrated, 'A bounded QA summary.');
  assert.equal(report.status, 'completed_with_source_gap');
  assert.equal(report.coverage.source_coverage_status, 'incomplete');
  assert.deepEqual(report.coverage.unavailable_sources, ['archived_media_index']);
  assert.equal(JSON.stringify(report).includes('qa_source_gap'), false);
});

test('zero adverse classifications produce a Safe profile with retained media', async () => {
  const integrated = await (await post(input)).json();
  integrated.event_register.articles = integrated.event_register.articles.map((article, index) => ({
    ...article, adverseness: index === 0 ? 'non-adverse' : 'inconclusive',
    incident_id: null, incident_reason: 'not_an_adverse_incident'
  }));
  integrated.event_register.incidents = [];
  const report = publicIncidentReport(integrated, 'No article was classified adverse.');
  assert.equal(report.screening_result, 'Safe');
  assert.equal(report.event_register.articles.length, 2);
  assert.deepEqual(report.event_register.articles.map((article) => article.adverseness),
    ['non-adverse', 'inconclusive']);
});

test('end-to-end route returns provider-neutral JSON and a fully signed PDF', async () => {
  const response = await reportPost(input);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.contract, 'adverse-media-incident-report-v1');
  assert.equal(report.report.digitally_signed, true);
  assert.equal(report.event_register.articles.length, 2);
  assert.equal(report.event_register.incidents.length, 1);
  assert.equal(report.event_register.articles[0].evidence_grade, 'article_body');
  assert.equal(report.coverage.article_bodies_available, 1);
  const publicText = JSON.stringify({ ...report, report: {
    ...report.report, pdf_base64: undefined } });
  assert.doesNotMatch(publicText, /mistral|ministral|jev|gemini|brave|typesafe|event.?registry|provider|model/i);
  const pdf = Buffer.from(report.report.pdf_base64, 'base64');
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), report.report.page_count);
  assert.match(pdf.toString('latin1'), /\/SubFilter\s*\/adbe\.pkcs7\.detached/);
  assert.match(pdf.toString('latin1'), /\/ByteRange\s*\[/);
});

test('subject-only API call returns the final JSON and signed PDF without local finalization', async () => {
  qaSourceGap = true;
  try {
    const response = await reportPost({ subject: { name: input.subject.name } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.adverse_profile, 'all');
    assert.equal(result.status, 'completed_with_source_gap');
    assert.equal(result.coverage.source_coverage_status, 'incomplete');
    assert.equal(result.report.digitally_signed, true);
    assert.ok(result.event_register.articles.length >= 2);
    assert.equal(result.report.sha256.length, 64);
    assert.match(Buffer.from(result.report.pdf_base64, 'base64').toString('latin1'),
      /\/SubFilter\s*\/adbe\.pkcs7\.detached/);
  } finally { qaSourceGap = false; }
});

test('no-media case returns Safe JSON and a one-page signed PDF with names actually searched', async () => {
  const previousNews = newsRows;
  const previousArchive = archiveRows;
  newsRows = [];
  archiveRows = [];
  calls.length = 0;
  try {
    const response = await reportPost({ subject: {
      name: 'Arbaz Uddin', entity_type: 'individual', aliases: [] },
    date_from: '2026-11-01', date_to: '2026-11-25' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.screening_result, 'Safe');
    assert.equal(result.status, 'completed');
    assert.match(result.summary, /No public adverse media evidence found/);
    assert.deepEqual(result.search_names, { primary: 'Arbaz Uddin', aliases: [],
      transliterations: { ar: ['أرباز الدين'], hi: ['अरबाज़ उद्दीन'] } });
    assert.equal(result.coverage.reviewed, 0);
    assert.deepEqual(result.event_register, { articles: [], incidents: [] });
    assert.equal(result.report.page_count, 1);
    assert.equal(result.report.digitally_signed, true);
    assert.doesNotMatch(JSON.stringify({ ...result, report: {
      ...result.report, pdf_base64: undefined } }),
    /mistral|ministral|jev|gemini|brave|typesafe|event.?registry|provider|model/i);
    const pdf = Buffer.from(result.report.pdf_base64, 'base64');
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
    assert.match(pdf.toString('latin1'), /\/SubFilter\s*\/adbe\.pkcs7\.detached/);
    const searchCalls = calls.filter((item) => item.address.includes('search.brave.com'));
    assert.equal(searchCalls.length, 6);
    assert.deepEqual([...new Set(searchCalls.map((item) => new URL(item.address).searchParams.get('q')))],
      ['"Arbaz Uddin"', '"أرباز الدين"', '"अरबाज़ उद्दीन"']);
    assert.equal(calls.filter((item) => item.address.includes('eventregistry.org')).length, 0);
    assert.equal(calls.filter((item) => item.address.includes('typesafe.ai')).length, 0);
    assert.equal(calls.filter((item) => item.address.includes('api.mistral.ai')).length, 1);
  } finally { newsRows = previousNews; archiveRows = previousArchive; }
});

test('explicit unsigned report mode returns JSON and an unsigned PDF', async () => {
  const previousNews = newsRows;
  const previousArchive = archiveRows;
  newsRows = [];
  archiveRows = [];
  process.env.ADVERSE_MEDIA_ADVANCE_UNSIGNED_PDF_ENABLED = 'true';
  try {
    const response = await reportPost({ subject: { name: 'Arbaz Uddin', entity_type: 'individual' },
      date_from: '2026-11-01', date_to: '2026-11-25' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.screening_result, 'Safe');
    assert.equal(result.report.digitally_signed, false);
    const pdf = Buffer.from(result.report.pdf_base64, 'base64');
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
    assert.doesNotMatch(pdf.toString('latin1'), /\/SubFilter\s*\/adbe\.pkcs7\.detached/);
  } finally {
    delete process.env.ADVERSE_MEDIA_ADVANCE_UNSIGNED_PDF_ENABLED;
    newsRows = previousNews;
    archiveRows = previousArchive;
  }
});

test('caller-supplied transliterations are searched exactly without generating replacements', async () => {
  const previousNews = newsRows;
  const previousArchive = archiveRows;
  newsRows = [];
  archiveRows = [];
  calls.length = 0;
  try {
    const response = await reportPost({ subject: {
      name: 'Raj Malik', entity_type: 'individual', aliases: [],
      transliterations: { ar: ['راج مالك'], hi: ['राज मलिक'] } },
    date_from: '2026-11-01', date_to: '2026-11-25' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.screening_result, 'Safe');
    assert.deepEqual(result.search_names.transliterations,
      { ar: ['راج مالك'], hi: ['राज मलिक'] });
    assert.equal(calls.filter((item) => item.address.includes('api.mistral.ai')).length, 0);
    assert.deepEqual([...new Set(calls.filter((item) => item.address.includes('search.brave.com'))
      .map((item) => new URL(item.address).searchParams.get('q')))],
    ['"Raj Malik"', '"راج مالك"', '"राज मलिक"']);
  } finally { newsRows = previousNews; archiveRows = previousArchive; }
});

test('no-media source gap is Safe with explicit coverage limit and a signed one-page report', async () => {
  const previousNews = newsRows;
  const previousArchive = archiveRows;
  newsRows = [];
  archiveRows = [];
  qaSourceGap = true;
  try {
    const response = await reportPost({ subject: {
      name: 'Arbaz Uddin', entity_type: 'individual', aliases: [] },
    date_from: '2026-11-01', date_to: '2026-11-25' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.screening_result, 'Safe');
    assert.equal(result.status, 'completed_with_source_gap');
    assert.equal(result.coverage.source_coverage_status, 'incomplete');
    assert.deepEqual(result.coverage.unavailable_sources, ['archived_media_index']);
    assert.match(result.summary, /Safe applies only to the sources searched/i);
    assert.equal(result.report.page_count, 1);
  } finally { newsRows = previousNews; archiveRows = previousArchive; qaSourceGap = false; }
});

test('integrated route requires the internal token and fixed all profile', async () => {
  const beforeCalls = calls.length;
  assert.equal((await post(input, 'wrong')).status, 401);
  assert.equal((await post({ ...input, adverse_profile: 'selected' })).status, 400);
  assert.equal((await post({ ...input, countries: ['AE'] })).status, 400);
  assert.equal((await post({ ...input, date_to: 'invalid-date' })).status, 400);
  assert.equal(calls.length, beforeCalls);
});

test('empty archive uses extracted search evidence, while missing article bodies fail closed', async () => {
  archiveRows = [];
  const empty = await post(input);
  assert.equal(empty.status, 200);
  const recovered = await empty.json();
  assert.equal(recovered.coverage.archive.unique_shortlisted_urls, 0);
  assert.equal(recovered.coverage.event_registry.search_url_attempts, 2);
  assert.equal(recovered.coverage.event_registry.body_selected, 1);
  const finalEmpty = await reportPost(input);
  assert.equal(finalEmpty.status, 200);
  assert.equal((await finalEmpty.json()).coverage.article_bodies_available, 1);
  archiveRows = [archiveArticle];
  eventStatus = 204;
  const short = await post(input);
  assert.equal(short.status, 424);
  assert.deepEqual(await short.json(), { error: 'event_registry_no_article_body' });
  eventStatus = 503;
  const failed = await post(input);
  assert.equal(failed.status, 424);
  assert.deepEqual(await failed.json(), { error: 'event_registry_no_article_body' });
  eventStatus = 200;
  archiveRows = [archiveArticle];
});

test('archive shortlist exceeding the test limit fails before article extraction', async () => {
  archiveRows = [archiveArticle, { ...archiveArticle, recordId: 'archive-002',
    url: 'https://news.example.org/another-fraud' }];
  const before = calls.filter((item) => item.address.includes('eventregistry.org')).length;
  const response = await post({ ...input, max_articles: 1 });
  assert.equal(response.status, 424);
  assert.deepEqual(await response.json(), { error: 'archive_shortlist_exceeds_test_limit' });
  assert.equal(calls.filter((item) => item.address.includes('eventregistry.org')).length, before);
  archiveRows = [archiveArticle];
});

test('archive source pages all postings and extracts each shortlisted URL once', async () => {
  let pageCalls = 0;
  let extractionCalls = 0;
  const result = await collectJevArchiveArticles({ subject: input.subject,
    date_from: input.date_from, date_to: input.date_to, max_articles: 2,
    max_archive_postings: 10 }, { eventRegistryApiKey: 'fake-event-registry-key',
    archiveSearch,
    archivePage: async (_request, { cursor }) => {
      pageCalls += 1;
      return cursor ? { rows: [{ ...archiveArticle, recordId: 'duplicate-posting' }],
        done: true, nextCursor: null }
        : { rows: [archiveArticle], done: false, nextCursor: { index: 1 } };
    },
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://analytics.eventregistry.org/api/v1/extractArticleInfo');
      extractionCalls += 1;
      return Response.json({ title: eventArticle.title, urlCanonical: eventArticle.url, body });
    } });
  assert.equal(pageCalls, 2);
  assert.equal(result.coverage.postings_scanned, 2);
  assert.equal(result.coverage.shortlisted_postings, 2);
  assert.equal(result.coverage.unique_shortlisted_urls, 1);
  assert.equal(result.coverage.event_registry_bodies, 1);
  assert.equal(extractionCalls, 1);
});
