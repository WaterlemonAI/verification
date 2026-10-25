// Standard rates checked 2026-10-26:
// https://brave.com/search/api/ and https://ai.google.dev/gemini-api/docs/pricing
// Reserve room for API infrastructure before claiming a fully loaded cost.
// The USD 0.08 total remains a rollout gate until infrastructure cost is measured.
export const MAX_SCREENING_COST_USD = 0.08;
export const MAX_PROVIDER_COST_USD = 0.07;
const MAX_PROVIDER_MICRO_USD = Math.round(MAX_PROVIDER_COST_USD * 1_000_000);
const SEARCH_MICRO_USD = 5_000;
const AI_INPUT_MICRO_USD_PER_MILLION = 300_000;
const AI_OUTPUT_MICRO_USD_PER_MILLION = 2_500_000;

export function createScreeningCostGuard(fetchImpl) {
  let reservedMicroUsd = 0;
  return {
    get reservedProviderCostUsd() { return reservedMicroUsd / 1_000_000; },
    async fetch(input, options = {}) {
      const url = new URL(input);
      let costMicroUsd = 0;
      if (url.hostname === 'api.search.brave.com') {
        costMicroUsd = SEARCH_MICRO_USD;
      } else if (url.hostname === 'generativelanguage.googleapis.com') {
        const body = String(options.body || '');
        let payload;
        try { payload = JSON.parse(body); } catch { throw new Error('screening_cost_unknown_ai_request'); }
        const maxOutputTokens = payload.generationConfig?.maxOutputTokens;
        if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 2048) {
          throw new Error('screening_cost_unknown_ai_request');
        }
        // One input token per UTF-8 byte is a conservative upper bound for text JSON.
        const maximumInputTokens = Buffer.byteLength(body);
        costMicroUsd = Math.ceil((maximumInputTokens * AI_INPUT_MICRO_USD_PER_MILLION
          + maxOutputTokens * AI_OUTPUT_MICRO_USD_PER_MILLION) / 1_000_000);
      }
      if (reservedMicroUsd + costMicroUsd > MAX_PROVIDER_MICRO_USD) throw new Error('screening_cost_limit');
      // Reserve before dialing, including retries and failed calls, so concurrency cannot overspend.
      reservedMicroUsd += costMicroUsd;
      return fetchImpl(input, options);
    }
  };
}
