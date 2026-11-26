import { performance } from 'node:perf_hooks';
import { runJevIntegratedTest, validateJevIntegratedRequest } from './adverse-media-jev-integrated.mjs';
import { createMinistralJevSummary } from './adverse-media-jev-ministral-summary.mjs';
import { createJevIncidentPdf, jevIncidentReportModel } from './adverse-media-jev-report-pdf.mjs';
import { generateSearchTransliterations } from './adverse-media-search-transliterations.mjs';

export const PUBLIC_INCIDENT_REPORT_CONTRACT = 'adverse-media-incident-report-v1';
const INTERNAL_NAMES = /\b(?:mistral|ministral|jev|gemini|brave|typesafe|event[ _-]?registry|internal[ _-]?tool)\b/i;
const BRAVE_USD_PER_REQUEST = 5 / 1_000;
const ARTICLE_EXTRACTION_USD_PER_CALL = 0.05 * 90 / 5_000;
const SUMMARY_USD_PER_TOKEN = 0.1 / 1_000_000;
// UAE North Container Apps Standard active usage for the current API shape:
// 0.5 vCPU at $0.000024/vCPU-s and 1 GiB at $0.000003/GiB-s.
const API_ACTIVE_COMPUTE_USD_PER_SECOND = 0.5 * 0.000024 + 0.000003;

function genericEvidenceGrade(value) {
  return value === 'event_registry_body' ? 'article_body'
    : value === 'search_excerpt' ? 'search_excerpt' : 'metadata_only';
}

function noInternalNames(value) {
  if (INTERNAL_NAMES.test(JSON.stringify(value))) throw new Error('report_contains_internal_reference');
  return value;
}

export function publicIncidentReport(integrated, summary) {
  const model = jevIncidentReportModel(integrated);
  const sourceIncomplete = integrated.coverage?.archive?.snapshot?.qa_source_gap === true;
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('report_summary_required');
  const articles = model.articles.map((article) => ({
    story_key: article.story_key,
    incident_id: article.incident_id ?? null,
    title: article.title,
    url: article.url,
    publisher: article.publisher,
    published_at: article.published_at,
    excerpt: article.excerpt,
    adverseness: article.adverseness,
    relationship: article.relationship,
    evidence_grade: genericEvidenceGrade(article.evidence_grade),
    incident_reason: article.incident_reason ?? null
  }));
  const response = {
    contract: PUBLIC_INCIDENT_REPORT_CONTRACT,
    subject: { name: model.subject, entity_type: integrated.subject.entity_type || '' },
    ...(!articles.some((article) => article.adverseness === 'adverse')
      ? { screening_result: 'Safe' } : {}),
    adverse_profile: 'all',
    search_names: { primary: integrated.search_names?.primary || model.subject,
      aliases: [...(integrated.search_names?.aliases || [])],
      transliterations: integrated.search_names?.transliterations || { ar: [], hi: [] } },
    period: model.period,
    status: sourceIncomplete ? 'completed_with_source_gap' : 'completed',
    summary,
    policy_evaluation_status: model.policyStatus,
    coverage: {
      discovered: Number(model.coverage.unique_discovered || 0),
      reviewed: Number(model.coverage.reviewed || 0),
      retained: articles.length,
      redundant_removed: model.redundant,
      omitted_due_to_test_limit: Number(model.coverage.omitted_due_to_test_limit || 0),
      article_bodies_available: articles.filter((article) => article.evidence_grade === 'article_body').length,
      search_excerpts_available: articles.filter((article) => article.evidence_grade === 'search_excerpt').length,
      source_coverage_status: sourceIncomplete ? 'incomplete' : 'complete',
      unavailable_sources: sourceIncomplete ? ['archived_media_index'] : []
    },
    event_register: {
      articles,
      incidents: integrated.event_register.incidents.map((incident) => ({
        incident_id: incident.incident_id,
        incident_label: incident.incident_label,
        story_keys: [...incident.story_keys]
      }))
    },
    disclaimer: 'This screening report uses publicly available information from the sources searched during the stated period. Safe means no retained article was classified adverse; it is not a guarantee that no such information exists. It does not confirm allegations or assign blame or wrongdoing to the named subject. Verify sources and identity before making a decision.'
  };
  return noInternalNames(response);
}

export async function createAdverseMediaIncidentReport(input, {
  screeningDependencies, summaryApiKey, signing, allowUnsignedPdf = false, fetchImpl = fetch,
  runScreening = runJevIntegratedTest, summarize = createMinistralJevSummary,
  generateTransliterations = generateSearchTransliterations,
  renderPdf = createJevIncidentPdf
} = {}) {
  if ((!signing && !allowUnsignedPdf) || (signing && (!signing.p12Bytes || typeof signing.passphrase !== 'string')))
    throw new Error('pdf_signing_certificate_required');
  if (!summaryApiKey) throw new Error('summary_credential_required');
  let request = input && typeof input === 'object' && !Array.isArray(input)
    ? { ...input, adverse_profile: input.adverse_profile ?? 'all',
      countries: input.countries ?? [], max_articles: input.max_articles ?? 40 }
    : input;
  const started = performance.now();
  validateJevIntegratedRequest(request);
  let variantUsage = {};
  if (!request.subject.transliterations) {
    const generated = await generateTransliterations({ subject: request.subject,
      apiKey: summaryApiKey, fetchImpl });
    request = { ...request, subject: { ...request.subject,
      transliterations: generated.transliterations } };
    variantUsage = generated.usage || {};
  }
  const integrated = await runScreening(request, screeningDependencies);
  const screenedAt = performance.now();
  const narrative = await summarize({ response: integrated, apiKey: summaryApiKey, fetchImpl });
  const summarizedAt = performance.now();
  const publicResponse = publicIncidentReport(integrated, narrative.summary);
  const report = await renderPdf({ response: publicResponse,
    narrative: { summary: narrative.summary }, signing, allowUnsignedPdf });
  const finished = performance.now();
  const output = { ...publicResponse, report: {
    filename: report.filename,
    media_type: 'application/pdf',
    sha256: report.sha256,
    page_count: report.pageCount,
    digitally_signed: report.digitallySigned,
    pdf_base64: report.bytes.toString('base64')
  } };
  noInternalNames({ ...output, report: { ...output.report, pdf_base64: undefined } });
  const usage = integrated.usage || {};
  const summaryUsage = narrative.usage || {};
  const costs = {
    search_usd: Number((Number(usage.brave_calls || 0) * BRAVE_USD_PER_REQUEST).toFixed(6)),
    article_extraction_usd: Number((Number(usage.event_registry_calls || 0)
      * ARTICLE_EXTRACTION_USD_PER_CALL).toFixed(6)),
    screening_upper_usd: Number(usage.jev_cost_upper_bound_usd || 0),
    search_name_variants_usd: Number(((Number(variantUsage.prompt_tokens || 0)
      + Number(variantUsage.completion_tokens || 0)) * SUMMARY_USD_PER_TOKEN).toFixed(6)),
    summary_usd: Number(((Number(summaryUsage.prompt_tokens || 0)
      + Number(summaryUsage.completion_tokens || 0)) * SUMMARY_USD_PER_TOKEN).toFixed(6))
  };
  costs.provider_upper_usd = Number(Object.values(costs).reduce((sum, amount) => sum + amount, 0).toFixed(6));
  costs.server_active_compute_model_usd = Number(((finished - started) / 1_000
    * API_ACTIVE_COMPUTE_USD_PER_SECOND).toFixed(6));
  costs.total_variable_model_upper_usd = Number((costs.provider_upper_usd
    + costs.server_active_compute_model_usd).toFixed(6));
  return { response: output, pdf: report.bytes, audit: {
    timings_ms: { screening: Math.round(screenedAt - started),
      summary: Math.round(summarizedAt - screenedAt),
      pdf: Math.round(finished - summarizedAt), total: Math.round(finished - started) },
    usage: { ...usage, search_name_variants: variantUsage, summary: summaryUsage }, costs,
    source_coverage: integrated.coverage,
    incident_review: integrated.incident_review
  } };
}
