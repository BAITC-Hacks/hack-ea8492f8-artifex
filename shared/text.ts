export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  if (!quote.trim()) return null;
  const exact = text.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const pattern = quote
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const match = new RegExp(pattern, 'u').exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}
