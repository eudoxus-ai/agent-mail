/**
 * The Message-IDs in a References or In-Reply-To header.
 *
 * Splitting on whitespace is not enough. Real headers separate ids with commas
 * and carry comments or a quoted name beside them, and iCloud rejects a whole
 * search if one term is `<id>,`.
 */
export function parseMessageIds(header: string | null | undefined): string[] {
  return header?.match(/<[^<>\s]+>/g) ?? [];
}
