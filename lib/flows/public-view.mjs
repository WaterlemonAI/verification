// Presentation branding for authenticated Flo JSON. Stored audit records keep their original provider metadata.
const brand = (value, code) => value.replace(/gemini/gi, code ? 'ai7edd' : 'AI7EDD');

export function publicFloView(value, field = '', aiReview = false, provider = false, parent = '') {
  // Supplier declarations and extracted document facts keep their original spelling.
  if (['draft', 'prefill', 'value'].includes(field) || field === 'data' && parent === 'extraction_result') return value;
  const providerValue = provider || field === 'raw_response';
  if (Array.isArray(value)) return value.map((entry) => publicFloView(entry, field, aiReview, providerValue, parent));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      const visibleKey = key === 'gemini_review' ? 'ai7edd_review' : providerValue ? brand(key, true) : key;
      if (key === 'model_id' && typeof entry === 'string' && /gemini/i.test(entry))
        result[visibleKey] = 'AI7EDD';
      else result[visibleKey] = publicFloView(entry, key, aiReview || key === 'gemini_review', providerValue, field);
    }
    return result;
  }
  const code = ['reason_codes', 'reason_code', 'validation_errors', 'extraction_reason'].includes(field);
  const reviewText = ['rationale', 'processing_failure'].includes(field);
  const providerMetadata = providerValue && ['model', 'model_id', 'provider', 'error', 'error_code', 'message'].includes(field);
  if (typeof value === 'string' && (aiReview || code || reviewText || providerMetadata))
    return brand(value, code || providerMetadata);
  return value;
}
