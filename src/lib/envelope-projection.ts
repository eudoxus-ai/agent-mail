export const ALLOWED_FIELDS = [
  'uid', 'account_id', 'mailbox',
  'subject', 'date', 'message_id',
  'from_address', 'from_name',
  'snippet', 'flags',
  'list_id', 'list_unsubscribe', 'is_list_mail',
  'category',
  'target',
] as const;

export type Field = typeof ALLOWED_FIELDS[number];

interface FullResult {
  account_id: string;
  mailbox: string;
  uid: number;
  envelope: {
    message_id: string;
    subject: string;
    from: { address: string; name: string | null };
    date: string;
  };
  snippet: string;
  flags: string[];
  list_id: string | null;
  list_unsubscribe: string | null;
  is_list_mail: boolean;
  category: string;
  target: { account_id: string; uid: number; mailbox: string };
}

export function projectResult(
  r: FullResult,
  fields?: readonly string[] | null,
): Record<string, unknown> {
  if (!fields || fields.length === 0) {
    return r as unknown as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f) {
      case 'uid': out.uid = r.uid; break;
      case 'account_id': out.account_id = r.account_id; break;
      case 'mailbox': out.mailbox = r.mailbox; break;
      case 'subject': out.subject = r.envelope.subject; break;
      case 'date': out.date = r.envelope.date; break;
      case 'message_id': out.message_id = r.envelope.message_id; break;
      case 'from_address': out.from_address = r.envelope.from.address; break;
      case 'from_name': out.from_name = r.envelope.from.name; break;
      case 'snippet': out.snippet = r.snippet; break;
      case 'flags': out.flags = r.flags; break;
      case 'list_id': out.list_id = r.list_id; break;
      case 'list_unsubscribe': out.list_unsubscribe = r.list_unsubscribe; break;
      case 'is_list_mail': out.is_list_mail = r.is_list_mail; break;
      case 'category': out.category = r.category; break;
      case 'target': out.target = r.target; break;
    }
  }
  return out;
}
