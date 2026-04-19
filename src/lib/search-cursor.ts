export interface SearchCursorBoundaryRow {
  account_id: string;
  mailbox: string;
  uid: number;
}

export interface SearchCursor {
  before: string;
  // Every row at the oldest-date boundary of the previous page. On the next
  // page we keep rows whose date is strictly older than `before`, plus rows
  // whose date equals `before` but whose `{account_id, mailbox, uid}` triple
  // is NOT in this set. UIDs are only unique per account/mailbox so a scalar
  // cursor UID would drop cross-account boundary rows.
  boundary_seen: SearchCursorBoundaryRow[];
}

function isBoundaryRow(x: unknown): x is SearchCursorBoundaryRow {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.account_id === 'string' &&
    typeof r.mailbox === 'string' &&
    typeof r.uid === 'number'
  );
}

export function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!obj || typeof obj.before !== 'string') return null;
    if (!Array.isArray(obj.boundary_seen)) return null;
    if (!obj.boundary_seen.every(isBoundaryRow)) return null;
    return { before: obj.before, boundary_seen: obj.boundary_seen };
  } catch {
    return null;
  }
}
