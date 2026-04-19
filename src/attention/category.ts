export type Category =
  | 'newsletter'
  | 'promotional'
  | 'transactional'
  | 'notification'
  | 'personal';

interface Input {
  list_id: string | null;
  list_unsubscribe: string | null;
  subject: string;
}

const PROMO = /\b(\d{1,3}% ?off|sale|discount|deal|coupon|free shipping|limited time)\b/i;
const TXN = /\b(receipt|invoice|order (confirmation|shipped|delivered)|payment|refund|statement)\b/i;
const NOTIFY = /\b(alert|reminder|notification|security|verification code|2fa)\b/i;

export function classifyCategory(i: Input): Category {
  const s = i.subject ?? '';
  // Transactional wins — highest agent-action value
  if (TXN.test(s)) return 'transactional';
  // Promotional even if list-headers present (marketing mailings are still promo)
  if (PROMO.test(s)) return 'promotional';
  // Notification only when no list headers (personal-scope alerts, not list mail)
  if (NOTIFY.test(s) && !i.list_id) return 'notification';
  if (i.list_id || i.list_unsubscribe) return 'newsletter';
  return 'personal';
}
