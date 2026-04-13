import type { EmailMessage, Participant } from '../types.js';

export interface MessageSignals {
  // ─── Recipient signals ───
  direct_to_me: boolean;
  cc_to_me: boolean;
  is_bulk: boolean;

  // ─── Sender signals ───
  is_list_mail: boolean;
  is_automated: boolean;

  // ─── Thread signals ───
  thread_state: 'new' | 'awaiting_you' | 'awaiting_them' | 'resolved';
  in_reply_to_your_message: boolean;
  is_reply_in_thread_you_started: boolean;

  // ─── Network signals ───
  thread_participants: Participant[];
  thread_participant_count: number;
  thread_message_count: number;
  is_small_group: boolean;
  is_broadcast: boolean;

  // ─── Reserved for Z (Apfel) — always null in this MVP ───
  has_deadline_language: boolean | null;
  mentions_you_by_name: boolean | null;
  urgency_score: number | null;
}

export interface SignalContext {
  accountEmail: string;
  /** Ordered oldest → newest. May be empty for context-less computation. */
  threadMessages: EmailMessage[];
}

const AUTOMATED_LOCAL_PARTS = [
  /^no-?reply$/i,
  /^noreply[-._]/i,
  /^notifications?$/i,
  /^mailer-daemon$/i,
  /^postmaster$/i,
  /^bounce/i,
  /^auto-?reply/i,
  /^donotreply/i,
];

const SMALL_GROUP_THRESHOLD = 4;
const BROADCAST_THRESHOLD = 10;

export function computeSignals(
  msg: EmailMessage,
  context: SignalContext
): MessageSignals {
  const me = context.accountEmail.toLowerCase();
  const directTo = msg.to.some((p) => p.address === me);
  const ccTo = !directTo && msg.cc.some((p) => p.address === me);
  const isBulk = !directTo && !ccTo;

  const isListMail = Boolean(msg.listUnsubscribe);
  const isAutomated = isAutomatedSender(msg.from.address);

  const threadMsgs = context.threadMessages;
  const threadParticipants = collectParticipants(threadMsgs);
  const threadParticipantCount = threadParticipants.length;
  const threadMessageCount = threadMsgs.length;

  // Thread state
  let threadState: MessageSignals['thread_state'];
  if (threadMsgs.length <= 1) {
    threadState = 'new';
  } else {
    const last = threadMsgs[threadMsgs.length - 1];
    threadState = last.from.address === me ? 'awaiting_them' : 'awaiting_you';
  }
  // Override: notifications / list mail are never "awaiting you"
  if (isListMail || isAutomated) {
    threadState = 'new';
  }

  // Reply context
  const yourIds = new Set(
    threadMsgs
      .filter((m) => m.from.address === me)
      .map((m) => m.messageId)
  );
  const inReplyToYourMessage = Boolean(
    msg.inReplyTo && yourIds.has(msg.inReplyTo)
  );
  const isReplyInThreadYouStarted =
    threadMsgs.length > 0 && threadMsgs[0].from.address === me;

  // Network signals
  const recipientCountOnThisMessage = msg.to.length + msg.cc.length;
  const isSmallGroup = threadParticipantCount > 0
    ? threadParticipantCount <= SMALL_GROUP_THRESHOLD
    : recipientCountOnThisMessage + 1 <= SMALL_GROUP_THRESHOLD; // +1 for sender
  const isBroadcast = recipientCountOnThisMessage >= BROADCAST_THRESHOLD;

  return {
    direct_to_me: directTo,
    cc_to_me: ccTo,
    is_bulk: isBulk,
    is_list_mail: isListMail,
    is_automated: isAutomated,
    thread_state: threadState,
    in_reply_to_your_message: inReplyToYourMessage,
    is_reply_in_thread_you_started: isReplyInThreadYouStarted,
    thread_participants: threadParticipants,
    thread_participant_count: threadParticipantCount,
    thread_message_count: threadMessageCount,
    is_small_group: isSmallGroup,
    is_broadcast: isBroadcast,
    has_deadline_language: null,
    mentions_you_by_name: null,
    urgency_score: null,
  };
}

function isAutomatedSender(address: string): boolean {
  const localPart = address.toLowerCase().split('@')[0] ?? '';
  return AUTOMATED_LOCAL_PARTS.some((re) => re.test(localPart));
}

function collectParticipants(messages: EmailMessage[]): Participant[] {
  const seen = new Set<string>();
  const out: Participant[] = [];
  const add = (p: Participant) => {
    if (!p.address || seen.has(p.address)) return;
    seen.add(p.address);
    out.push(p);
  };
  for (const m of messages) {
    add(m.from);
    for (const t of m.to) add(t);
    for (const c of m.cc) add(c);
  }
  return out;
}
