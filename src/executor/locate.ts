export interface LocatableMailbox {
  existingUids(mailbox: string, uids: number[]): Promise<number[]>;
  uidsByMessageId(mailbox: string, messageIds: string[]): Promise<Map<string, number[]>>;
}

export interface Locatable {
  /** The UID recorded for this message in `mailbox`, if a move confirmed one. */
  uid: number | null;
  messageId?: string;
}

/**
 * Where each message is in a mailbox right now, or null if it isn't there.
 *
 * A recorded UID is only a claim: the message may have moved on since, and a
 * move can land without the server's reply reaching us. So a recorded UID counts
 * only if it still exists, and anything else is looked up by Message-Id.
 */
export async function locateMessages(
  imap: LocatableMailbox,
  mailbox: string,
  messages: Locatable[]
): Promise<Array<number | null>> {
  const recorded = messages.flatMap((m) => (m.uid === null ? [] : [m.uid]));
  const present = new Set(recorded.length > 0 ? await imap.existingUids(mailbox, recorded) : []);

  const isHere = (m: Locatable) => m.uid !== null && present.has(m.uid);
  const wanted = messages.flatMap((m) => (!isHere(m) && m.messageId ? [m.messageId] : []));
  const byId = wanted.length > 0 ? await imap.uidsByMessageId(mailbox, wanted) : new Map();

  return messages.map((m) => {
    if (isHere(m)) return m.uid;
    if (!m.messageId) return null;
    // Two copies can share a Message-Id, so each copy is handed out once, and
    // never one that another target already owns by UID.
    const hits: number[] = byId.get(m.messageId) ?? [];
    let hit = hits.shift();
    while (hit !== undefined && present.has(hit)) hit = hits.shift();
    return hit ?? null;
  });
}
