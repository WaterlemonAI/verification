// A review listing is an opinion source, not an independently reported event.
export function isConsumerReviewListing(article) {
  let url;
  try { url = new URL(article?.url); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.toLowerCase();
  const reviewPath = /(?:^|\/)(?:reviews?|ratings|customer-reviews|employee-reviews)(?:\/|$)/.test(path);
  const reviewTitle = /\b(?:reviews?|ratings|testimonials|customer experiences|employee experiences)\b/i
    .test(article?.title || '');
  const reviewHost = /(?:^|\.)(?:trustpilot\.com|sitejabber\.com|glassdoor\.com|yelp\.com|reviews\.io|consumeraffairs\.com|mouthshut\.com|ambitionbox\.com|indeed\.com)$/.test(host);
  return reviewPath && (reviewHost || reviewTitle);
}
