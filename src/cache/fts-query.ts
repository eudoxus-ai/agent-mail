/**
 * Convert arbitrary user text into a safe FTS5 MATCH expression.
 *
 * FTS5's MATCH argument is a query language, not a string literal. Passing raw
 * user input through it is the same class of mistake as string-concatenating
 * SQL: `q2-pricing` parses as a column filter and throws "no such column",
 * `foo:bar` targets a column that doesn't exist, and an unbalanced quote is a
 * syntax error. Every one of those is reachable from a plain `search_threads`
 * call, so user text is tokenized and re-emitted as quoted string literals.
 *
 * Quoting also means FTS5 operators (AND/OR/NOT/NEAR) lose their special
 * meaning. That's deliberate: `search_threads({query: "not urgent"})` should
 * find mail containing both words, which is what a user means, rather than
 * being parsed as a negation.
 */

/** Explicit "quoted phrases" survive as phrases; everything else is a term. */
const PHRASE_OR_TERM = /"([^"]*)"|(\S+)/g;

function quote(token: string): string {
  // Inside an FTS5 string literal, a double quote is escaped by doubling it.
  return `"${token.replace(/"/g, '""')}"`;
}

export interface FtsQueryOptions {
  /**
   * Treat a trailing `*` on a bare term as a prefix search. On by default —
   * it's the one operator worth keeping, and it's unambiguous.
   */
  allowPrefix?: boolean;
}

/**
 * Returns a MATCH-safe expression, or null when the input has no searchable
 * content. Callers must treat null as "no full-text constraint" rather than
 * passing an empty string to MATCH, which is itself a syntax error.
 */
export function toFtsMatchQuery(
  input: string | null | undefined,
  options: FtsQueryOptions = {}
): string | null {
  const allowPrefix = options.allowPrefix ?? true;
  if (!input) return null;

  const parts: string[] = [];

  for (const match of input.matchAll(PHRASE_OR_TERM)) {
    const phrase = match[1];
    const term = match[2];

    if (phrase !== undefined) {
      const trimmed = phrase.trim();
      if (trimmed) parts.push(quote(trimmed));
      continue;
    }

    if (term === undefined) continue;

    if (allowPrefix && term.length > 1 && term.endsWith('*')) {
      const stem = term.slice(0, -1);
      if (stem) parts.push(`${quote(stem)}*`);
      continue;
    }

    parts.push(quote(term));
  }

  if (parts.length === 0) return null;

  // Space-separated terms are implicitly AND-ed by FTS5.
  return parts.join(' ');
}
