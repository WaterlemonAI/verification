// Standard rates checked 2026-10-26:
// https://brave.com/search/api/ and https://ai.google.dev/gemini-api/docs/pricing
// Reserve room for API infrastructure before claiming a fully loaded cost.
// Keep provider activity below the owner's USD 0.15 fully loaded ceiling while
// reserving room for API compute, storage, and delivery.
export const MAX_SCREENING_COST_USD = 0.15;
export const MAX_PROVIDER_COST_USD = 0.14;
export const MAX_PROVIDER_MICRO_USD = Math.round(MAX_PROVIDER_COST_USD * 1_000_000);
const SEARCH_MICRO_USD = 5_000;
const AI_INPUT_MICRO_USD_PER_MILLION = 300_000;
const AI_OUTPUT_MICRO_USD_PER_MILLION = 2_500_000;

export function createScreeningCostGuard(fetchImpl, { reserve = async () => {} } = {}) {
  let reservedMicroUsd = 0;
  const providerCalls = { brave: 0, gemini: 0 };
  return {
    get reservedProviderCostUsd() { return reservedMicroUsd / 1_000_000; },
    get providerCalls() { return { ...providerCalls }; },
    async fetch(input, options = {}) {
      const url = new URL(input);
      let costMicroUsd = 0;
      let provider = '';
      if (url.hostname === 'api.search.brave.com') {
        costMicroUsd = SEARCH_MICRO_USD;
        provider = 'brave';
      } else if (url.hostname === 'generativelanguage.googleapis.com') {
        provider = 'gemini';
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
      if (costMicroUsd) await reserve({ costMicroUsd, provider, maxMicroUsd: MAX_PROVIDER_MICRO_USD });
      reservedMicroUsd += costMicroUsd;
      if (provider) providerCalls[provider] += 1;
      return fetchImpl(input, options);
    }
  };
}
