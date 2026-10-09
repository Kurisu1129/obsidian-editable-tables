/** Minimal HTML text helpers. Deliberately dependency-free so the model layer stays testable. */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * `String.fromCodePoint` throws a RangeError for anything outside the Unicode range.
 * That exception would escape the StateField that parses tables, so a single malformed
 * entity anywhere in a note would leave that note's editor unusable. Acceptable input
 * must therefore be validated, not merely finite.
 */
function fromCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null; // lone surrogate
  return String.fromCodePoint(code);
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const decoded = fromCodePoint(parseInt(body.slice(2), 16));
      return decoded ?? whole;
    }
    if (body.startsWith('#')) {
      const decoded = fromCodePoint(parseInt(body.slice(1), 10));
      return decoded ?? whole;
    }
    const named = NAMED[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strips tags to obtain the plain-text form of a fragment. `<br>` becomes a newline. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  ).trim();
}

/** True when the fragment carries inline markup that plain text would lose. */
export function hasMarkup(html: string): boolean {
  return /<[a-zA-Z/][^>]*>/.test(html);
}

const ATTR_RE = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');

export function getAttr(tag: string, name: string): string | null {
  const m = tag.match(ATTR_RE(name));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

export function getSpan(tag: string, name: 'colspan' | 'rowspan'): number {
  const raw = getAttr(tag, name);
  if (raw === null) return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
