export interface SearchCursor {
  before: string;
  lastUid: number;
}

export function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (obj && typeof obj.before === 'string' && typeof obj.lastUid === 'number') {
      return { before: obj.before, lastUid: obj.lastUid };
    }
    return null;
  } catch {
    return null;
  }
}
