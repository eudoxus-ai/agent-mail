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
  from_address?: string | null;
}

const PROMO = /\b(\d{1,3}% ?off|sale|discount|deal|coupon|free shipping|limited time|black friday|cyber monday)\b/i;
const TXN = /\b(receipt|invoice|order (confirmation|shipped|delivered)|payment|refund|statement)\b/i;
const NOTIFY = /\b(alert|reminder|notification|security|verification code|2fa)\b/i;
// A local part nobody reads, alone or with a tag after it (noreply+abc, bounces-123).
const AUTOMATED_SENDER =
  /^(no[-_]?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounces?|alerts)([+._-].*)?$/i;

function localPart(address: string | null | undefined): string {
  return (address ?? '').split('@')[0];
}

/** Checked in order; the first rule that matches decides. */
const RULES: Array<[Category, (i: Input) => boolean]> = [
  // Transactional wins — highest agent-action value
  ['transactional', (i) => TXN.test(i.subject ?? '')],
  // Promotional even if list-headers present (marketing mailings are still promo)
  ['promotional', (i) => PROMO.test(i.subject ?? '')],
  // Notification only when no list headers (personal-scope alerts, not list mail)
  ['notification', (i) => NOTIFY.test(i.subject ?? '') && !i.list_id],
  ['newsletter', (i) => Boolean(i.list_id || i.list_unsubscribe)],
  // Looks personal, but no person sent it.
  ['notification', (i) => AUTOMATED_SENDER.test(localPart(i.from_address))],
];

export function classifyCategory(i: Input): Category {
  return RULES.find(([, matches]) => matches(i))?.[0] ?? 'personal';
}
