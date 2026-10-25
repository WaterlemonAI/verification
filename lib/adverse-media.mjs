import { createHash, randomUUID } from 'node:crypto';

const BRAVE_SEARCH_ORIGIN = 'https://api.search.brave.com';
const MAX_LANGUAGES = 5;
const MAX_PAID_QUERIES = 12;
const SEARCH_COST_USD = 0.005;
const CACHE_TTL_MS = 15 * 60 * 1000;

const LANGUAGE_NAMES = {
  ar: 'Arabic', de: 'German', en: 'English', es: 'Spanish', fa: 'Persian', fr: 'French',
  hi: 'Hindi', it: 'Italian', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', ru: 'Russian',
  tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu', zh: 'Chinese'
};

const CATEGORY_TERMS = {
  en: {
    financial_crime: ['fraud', 'scam', 'embezzlement', 'money laundering', 'bribery', 'corruption'],
    crime_and_enforcement: ['arrested', 'charged', 'convicted', 'indicted', 'investigation', 'prosecution'],
    sanctions_and_security: ['sanctioned', 'sanctions evasion', 'terrorism', 'terrorist financing', 'organized crime'],
    regulatory_and_governance: ['regulatory action', 'fined', 'penalty', 'misconduct', 'insolvency', 'bankruptcy']
  },
  ar: {
    financial_crime: ['احتيال', 'نصب', 'اختلاس', 'غسل الأموال', 'رشوة', 'فساد'],
    crime_and_enforcement: ['اعتقال', 'ألقي القبض', 'متهم', 'إدانة', 'تحقيق', 'محاكمة'],
    sanctions_and_security: ['عقوبات', 'تمويل الإرهاب', 'إرهاب', 'جريمة منظمة'],
    regulatory_and_governance: ['غرامة', 'مخالفة', 'إفلاس', 'سوء سلوك', 'إجراء تنظيمي']
  },
  fr: {
    financial_crime: ['fraude', 'escroquerie', 'détournement', 'blanchiment', 'corruption', 'pot-de-vin'],
    crime_and_enforcement: ['arrêté', 'inculpé', 'condamné', 'enquête', 'poursuites'],
    sanctions_and_security: ['sanctions', 'terrorisme', 'crime organisé'],
    regulatory_and_governance: ['amende', 'faute professionnelle', 'insolvabilité', 'faillite']
  },
  es: {
    financial_crime: ['fraude', 'estafa', 'malversación', 'lavado de dinero', 'soborno', 'corrupción'],
    crime_and_enforcement: ['detenido', 'acusado', 'condenado', 'investigación', 'procesamiento'],
    sanctions_and_security: ['sanciones', 'terrorismo', 'crimen organizado'],
    regulatory_and_governance: ['multa', 'mala conducta', 'insolvencia', 'quiebra']
  },
  ru: {
    financial_crime: ['мошенничество', 'афера', 'хищение', 'отмывание денег', 'взяточничество', 'коррупция'],
    crime_and_enforcement: ['арестован', 'обвинен', 'осужден', 'расследование', 'уголовное дело'],
    sanctions_and_security: ['санкции', 'терроризм', 'организованная преступность'],
    regulatory_and_governance: ['штраф', 'нарушение', 'неплатежеспособность', 'банкротство']
  },
  hi: {
    financial_crime: ['धोखाधड़ी', 'घोटाला', 'गबन', 'मनी लॉन्ड्रिंग', 'रिश्वत', 'भ्रष्टाचार'],
    crime_and_enforcement: ['गिरफ्तार', 'आरोपी', 'दोषी', 'जांच', 'अभियोजन'],
    sanctions_and_security: ['प्रतिबंध', 'आतंकवाद', 'संगठित अपराध'],
    regulatory_and_governance: ['जुर्माना', 'कदाचार', 'दिवालियापन']
  },
  ur: {
    financial_crime: ['دھوکہ دہی', 'فراڈ', 'غبن', 'منی لانڈرنگ', 'رشوت', 'بدعنوانی'],
    crime_and_enforcement: ['گرفتار', 'ملزم', 'مجرم', 'تحقیقات', 'مقدمہ'],
    sanctions_and_security: ['پابندیاں', 'دہشت گردی', 'منظم جرم'],
    regulatory_and_governance: ['جرمانہ', 'بدانتظامی', 'دیوالیہ']
  },
  zh: {
    financial_crime: ['欺诈', '诈骗', '挪用', '洗钱', '贿赂', '腐败'],
    crime_and_enforcement: ['逮捕', '被控', '定罪', '调查', '起诉'],
    sanctions_and_security: ['制裁', '恐怖主义', '有组织犯罪'],
    regulatory_and_governance: ['罚款', '违规', '破产', '资不抵债']
  }
};

const STAGE_TERMS = {
  convicted: ['convicted', 'sentenced', 'guilty', 'condamné', 'condenado', 'осужден', 'दोषी', 'مجرم', 'إدانة', '定罪'],
  charged: ['charged', 'indicted', 'inculpé', 'acusado', 'обвинен', 'आरोपी', 'ملزم', 'متهم', '被控'],
  arrested: ['arrested', 'detained', 'arrêté', 'detenido', 'арестован', 'गिरफ्तार', 'گرفتار', 'اعتقال', '逮捕'],
  investigation: ['investigation', 'probe', 'enquête', 'investigación', 'расследование', 'जांच', 'تحقیقات', 'تحقيق', '调查'],
  regulatory_action: ['regulatory action', 'fined', 'penalty', 'amende', 'multa', 'штраф', 'जुर्माना', 'جرمانہ', 'غرامة', '罚款'],
  allegation: ['alleged', 'accused', 'accusé', 'presunto', 'предполагаемый', 'कथित', 'مبینہ', 'مزعوم', '涉嫌']
};

const CATEGORY_SEVERITY = {
  financial_crime: 0.9,
  crime_and_enforcement: 0.8,
  sanctions_and_security: 1,
  regulatory_and_governance: 0.65
};

const cache = new Map();

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function cleanString(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function uniqueStrings(value, maxItems, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function validDate(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return null;
  return value;
}

export function validateAdverseMediaRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The request must be a JSON object.');
  const entityType = cleanString(input.entity_type || input.type, 30).toLowerCase();
  const name = cleanString(input.name, 200);
  const aliases = uniqueStrings(input.aliases || input.alias, 10);
  const countries = uniqueStrings(input.countries || (input.country ? [input.country] : []), 10, 2).map((item) => item.toUpperCase());
  const requestedLanguages = uniqueStrings(input.languages, MAX_LANGUAGES, 5).map((item) => item.toLowerCase());
  const languages = requestedLanguages.length ? requestedLanguages : ['en', 'ar'];
  const dateFrom = validDate(cleanString(input.date_from, 10));
  const dateTo = validDate(cleanString(input.date_to, 10));
  const maxResults = input.max_results === undefined ? 25 : Number(input.max_results);

  if (!['individual', 'business'].includes(entityType)) throw new Error('entity_type must be individual or business.');
  if (name.length < 2) throw new Error('name must contain at least two characters.');
  if (countries.some((item) => !/^[A-Z]{2}$/.test(item))) throw new Error('countries must contain ISO 3166-1 alpha-2 codes.');
  if (languages.some((item) => !Object.hasOwn(LANGUAGE_NAMES, item))) {
    throw new Error(`languages supports: ${Object.keys(LANGUAGE_NAMES).join(', ')}.`);
  }
  if (dateFrom === null || dateTo === null) throw new Error('date_from and date_to must use YYYY-MM-DD.');
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('date_from must not be after date_to.');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) throw new Error('max_results must be an integer from 1 to 50.');

  return {
    entity_type: entityType,
    name,
    aliases,
    countries,
    date_from: dateFrom || '',
    date_to: dateTo || '',
    languages,
    max_results: maxResults
  };
}

function phrase(value) {
  return `"${String(value).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

function queryNames(request) {
  return [request.name, ...request.aliases].slice(0, 3).map(phrase).join(' OR ');
}

function queryGroups(request) {
  const names = queryNames(request);
  const groups = [];
  for (const language of request.languages) {
    const dictionary = CATEGORY_TERMS[language] || CATEGORY_TERMS.en;
    const financial = [...dictionary.financial_crime, ...dictionary.sanctions_and_security].slice(0, 10);
    const enforcement = [...dictionary.crime_and_enforcement, ...dictionary.regulatory_and_governance].slice(0, 10);
    groups.push({ kind: 'news', language, query: `(${names}) (${financial.map(phrase).join(' OR ')})` });
    groups.push({ kind: 'news', language, query: `(${names}) (${enforcement.map(phrase).join(' OR ')})` });
  }
  for (const language of request.languages.slice(0, 2)) {
    const dictionary = CATEGORY_TERMS[language] || CATEGORY_TERMS.en;
    const official = [...dictionary.crime_and_enforcement, ...dictionary.regulatory_and_governance].slice(0, 8);
    groups.push({ kind: 'web', language, query: `(${names}) (${official.map(phrase).join(' OR ')})` });
  }
  return groups.slice(0, MAX_PAID_QUERIES);
}

function freshness(request) {
  if (!request.date_from && !request.date_to) return '';
  const from = request.date_from || '2000-01-01';
  const to = request.date_to || new Date().toISOString().slice(0, 10);
  return `${from}to${to}`;
}

async function braveSearch(group, request, apiKey, fetchImpl) {
  const endpoint = group.kind === 'news' ? '/res/v1/news/search' : '/res/v1/web/search';
  const url = new URL(endpoint, BRAVE_SEARCH_ORIGIN);
  url.searchParams.set('q', group.query.slice(0, 400));
  url.searchParams.set('count', '20');
  url.searchParams.set('search_lang', group.language);
  url.searchParams.set('country', 'ALL');
  url.searchParams.set('safesearch', 'moderate');
  url.searchParams.set('extra_snippets', 'true');
  const dateRange = freshness(request);
  if (dateRange) url.searchParams.set('freshness', dateRange);

  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    const error = new Error(`search_failed_${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  const payload = await response.json();
  const results = group.kind === 'news' ? payload.results : payload.web?.results;
  return (Array.isArray(results) ? results : []).map((result) => ({ ...result, _queryLanguage: group.language, _sourceType: group.kind }));
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return String(raw || ''); }
}

function domainOf(raw) {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function resultText(result) {
  return [result.title, result.description, ...(Array.isArray(result.extra_snippets) ? result.extra_snippets : [])].filter(Boolean).join(' ');
}

function entityMatch(result, request) {
  const text = normalizeText(resultText(result));
  const candidates = [request.name, ...request.aliases].map(normalizeText).filter(Boolean);
  let best = 0;
  let matchedAlias = '';
  for (const candidate of candidates) {
    let score = 0;
    if (text.includes(candidate)) score = 1;
    else {
      const tokens = candidate.split(' ').filter((token) => token.length > 1);
      const matched = tokens.filter((token) => text.includes(token)).length;
      score = tokens.length ? matched / tokens.length : 0;
      if (tokens.length === 1 && score === 1) score = 0.62;
    }
    if (score > best) { best = score; matchedAlias = candidates[candidates.indexOf(candidate)] || ''; }
  }
  const countryBoost = request.countries.some((country) => text.includes(country.toLowerCase())) ? 0.04 : 0;
  return { score: round(clamp(best + countryBoost)), matchedAlias };
}

function classify(result) {
  const normalized = normalizeText(resultText(result));
  const categories = [];
  const matchedTerms = [];
  for (const [language, dictionary] of Object.entries(CATEGORY_TERMS)) {
    for (const [category, terms] of Object.entries(dictionary)) {
      const hits = terms.filter((term) => normalized.includes(normalizeText(term)));
      if (hits.length) {
        if (!categories.includes(category)) categories.push(category);
        matchedTerms.push(...hits.map((term) => ({ language, term })));
      }
    }
  }
  let legalStage = 'media_mention';
  for (const [stage, terms] of Object.entries(STAGE_TERMS)) {
    if (terms.some((term) => normalized.includes(normalizeText(term)))) { legalStage = stage; break; }
  }
  const title = normalizeText(result.title);
  const titleHits = matchedTerms.filter(({ term }) => title.includes(normalizeText(term))).length;
  const relevance = clamp((matchedTerms.length * 0.12) + (titleHits * 0.16), 0, 1);
  return { categories, matchedTerms: matchedTerms.slice(0, 12), legalStage, relevance: round(relevance) };
}

function sourceReliability(domain) {
  if (!domain) return 0.5;
  if (/\.(gov|gov\.[a-z]{2}|int)$/.test(domain) || domain.endsWith('.gov.ae')) return 0.95;
  if (/\.(edu|ac\.[a-z]{2})$/.test(domain)) return 0.85;
  return 0.68;
}

function riskLevel(score) {
  if (score >= 0.8) return 'high';
  if (score >= 0.62) return 'medium';
  return 'low';
}

function publishedAt(result) {
  const value = result.page_age || result.age || result.published || '';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value || '') : new Date(parsed).toISOString();
}

function normalizedResult(result, request) {
  const url = canonicalUrl(result.url);
  const domain = domainOf(url);
  const match = entityMatch(result, request);
  const adverse = classify(result);
  if (match.score < 0.5 || !adverse.categories.length) return null;
  const severity = Math.max(...adverse.categories.map((category) => CATEGORY_SEVERITY[category] || 0.5));
  const reliability = sourceReliability(domain);
  const score = round(clamp((match.score * 0.45) + (adverse.relevance * 0.3) + (severity * 0.15) + (reliability * 0.1)));
  return {
    result_id: createHash('sha256').update(`${url}\n${result.title || ''}`).digest('hex').slice(0, 20),
    title: cleanString(result.title, 500),
    url,
    publisher: cleanString(result.meta_url?.hostname || domain, 200),
    published_at: publishedAt(result),
    language: result._queryLanguage,
    source_type: result._sourceType === 'news' ? 'news_index' : 'open_web',
    excerpt: cleanString(result.description || result.extra_snippets?.[0], 1200),
    matched_name: match.matchedAlias,
    entity_match_score: match.score,
    adverse_relevance_score: adverse.relevance,
    source_reliability_score: reliability,
    severity_score: severity,
    risk_score: score,
    risk_level: riskLevel(score),
    categories: adverse.categories,
    legal_stage: adverse.legalStage,
    matched_terms: adverse.matchedTerms,
    review_required: true
  };
}

function deduplicate(results) {
  const byKey = new Map();
  for (const result of results) {
    const urlKey = canonicalUrl(result.url);
    const titleKey = normalizeText(result.title);
    const key = urlKey || titleKey;
    const existing = byKey.get(key);
    if (!existing || result.risk_score > existing.risk_score) byKey.set(key, result);
  }
  return [...byKey.values()];
}

function cacheKey(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

export async function screenAdverseMedia({ request, apiKey, fetchImpl = fetch }) {
  const key = cacheKey(request);
  const cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) {
    const response = clone(cached.response);
    response.screening_id = randomUUID();
    response.completed_at = new Date().toISOString();
    response.usage.cache_hit = true;
    response.usage.paid_search_queries = 0;
    response.usage.estimated_search_cost_usd = 0;
    return response;
  }

  const queries = queryGroups(request);
  const settled = await Promise.allSettled(queries.map((group) => braveSearch(group, request, apiKey, fetchImpl)));
  const rawResults = settled.flatMap((item) => item.status === 'fulfilled' ? item.value : []);
  const failedQueries = settled.filter((item) => item.status === 'rejected').length;
  if (!rawResults.length && failedQueries === queries.length) {
    const error = new Error('search_provider_unavailable');
    error.statusCode = settled.find((item) => item.status === 'rejected')?.reason?.statusCode || 502;
    throw error;
  }

  const results = deduplicate(rawResults.map((item) => normalizedResult(item, request)).filter(Boolean))
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, request.max_results);
  const categoryCounts = {};
  for (const result of results) {
    for (const category of result.categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
  }
  const highestScore = results[0]?.risk_score || 0;
  const overallRisk = results.length ? riskLevel(highestScore) : 'no_material_results';
  const response = {
    screening_id: randomUUID(),
    status: 'completed',
    completed_at: new Date().toISOString(),
    entity: {
      entity_type: request.entity_type,
      name: request.name,
      aliases: request.aliases,
      countries: request.countries
    },
    summary: {
      risk_level: overallRisk,
      highest_risk_score: highestScore,
      potentially_relevant_results: results.length,
      categories: categoryCounts,
      human_review_required: results.length > 0,
      statement: results.length
        ? `${results.length} potentially relevant media result${results.length === 1 ? '' : 's'} require human review.`
        : 'No materially adverse results were identified in the sources searched. This is not proof that adverse information does not exist.'
    },
    coverage: {
      coverage_type: 'open-web adverse media screening',
      indexes: ['global_news', 'open_web'],
      languages_searched: request.languages.map((code) => ({ code, name: LANGUAGE_NAMES[code] })),
      date_from: request.date_from || null,
      date_to: request.date_to || null,
      searched_at: new Date().toISOString(),
      limitation: 'Coverage is limited to indexed, publicly discoverable sources and cannot guarantee every publication.'
    },
    methodology: {
      version: 'ai7-adverse-media-rules-v1',
      classification: 'multilingual evidence-based rules',
      scores_are_decisions: false,
      note: 'Results are leads for qualified human review and do not establish guilt or wrongdoing.'
    },
    usage: {
      cache_hit: false,
      paid_search_queries: queries.length,
      failed_search_queries: failedQueries,
      maximum_paid_queries: MAX_PAID_QUERIES,
      estimated_search_cost_usd: round(queries.length * SEARCH_COST_USD),
      cost_guardrail_usd: 0.12
    },
    results
  };

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response: clone(response) });
  if (cache.size > 500) {
    for (const [cacheEntryKey, value] of cache) if (value.expiresAt <= Date.now()) cache.delete(cacheEntryKey);
  }
  return response;
}

export const adverseMediaConfig = {
  supportedLanguages: LANGUAGE_NAMES,
  maxLanguages: MAX_LANGUAGES,
  maxPaidQueries: MAX_PAID_QUERIES,
  searchCostUsd: SEARCH_COST_USD
};
