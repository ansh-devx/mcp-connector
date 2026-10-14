/** Small, dependency-free text helpers shared by query building, filtering and ranking. */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s./-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words that carry no catalog signal. Dropping them keeps "I need something
 * casual for a dinner under 3000" from searching Shopify for "i", "need", "under".
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with',
  'from', 'as', 'is', 'are', 'was', 'be', 'been', 'am', 'i', 'me', 'my', 'we', 'us', 'our',
  'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'find', 'show', 'get', 'give', 'need', 'want', 'looking', 'look', 'search', 'searching',
  'buy', 'shop', 'shopping', 'recommend', 'suggest', 'please', 'help', 'something', 'anything',
  'some', 'any', 'all', 'more', 'most', 'few', 'lot', 'lots',
  'under', 'below', 'above', 'over', 'less', 'least', 'than', 'up', 'upto', 'around',
  'between', 'within', 'max', 'maximum', 'min', 'minimum', 'budget', 'price', 'priced',
  'cheap', 'cheaper', 'cheapest', 'affordable', 'expensive',
  'rs', 'inr', 'usd', 'rupees', 'rupee', 'dollars', 'dollar',
  'product', 'products', 'item', 'items', 'option', 'options', 'thing', 'things',
  'available', 'availability', 'stock', 'size', 'sizes', 'colour', 'colours', 'color', 'colors',
  'do', 'does', 'have', 'has', 'can', 'could', 'would', 'should', 'will', 'want',
  'good', 'nice', 'best', 'top',
]);

export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word);
}

/**
 * Split a shopper's phrase into meaningful search terms.
 * Drops stop words, bare numbers (budgets) and 1-character noise.
 */
export function tokenize(input: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of normalize(input).split(/[\s./-]+/)) {
    const word = raw.trim();
    if (word.length < 2) continue;
    if (/^\d+$/.test(word)) continue; // "2000" in "under 2000" is a budget, not a keyword
    if (isStopWord(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
  }
  return terms;
}

/** Every token, stop words included — used for matching against product text. */
export function allTokens(input: string): string[] {
  return normalize(input)
    .split(/[\s./-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Whole-word containment, so "red" does not match "shredded". */
export function containsTerm(haystack: string, term: string): boolean {
  if (!haystack || !term) return false;
  const tokens = allTokens(haystack);
  const needle = normalize(term);
  if (needle.includes(' ')) return normalize(haystack).includes(needle);
  return tokens.includes(needle);
}

/** Escapes a value so it can be embedded in a quoted Shopify search literal. */
export function escapeShopifyQueryValue(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}
