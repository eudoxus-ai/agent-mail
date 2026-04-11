import type { EmailMessage, EmailThread } from '../types.js';

/**
 * Build threads from a flat list of messages using In-Reply-To and References headers.
 * Messages sharing any reference ID are grouped into the same thread (union-find).
 */
export function buildThreads(
  messages: EmailMessage[],
  accountId: string
): EmailThread[] {
  // Map from message-id to group representative
  const parent = new Map<string, string>();

  function find(id: string): string {
    if (!parent.has(id)) {
      parent.set(id, id);
      return id;
    }
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = id;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(rb, ra);
    }
  }

  // Build union-find from references
  for (const msg of messages) {
    const id = msg.messageId;
    find(id); // ensure in map

    if (msg.inReplyTo) {
      union(id, msg.inReplyTo);
    }
    for (const ref of msg.references) {
      union(id, ref);
    }
  }

  // Group messages by root
  const groups = new Map<string, EmailMessage[]>();
  for (const msg of messages) {
    const root = find(msg.messageId);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(msg);
  }

  // Convert groups to threads
  const threads: EmailThread[] = [];
  for (const [threadId, msgs] of groups) {
    // Sort messages chronologically
    msgs.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    const participants = new Set<string>();
    for (const msg of msgs) {
      participants.add(msg.from);
      for (const to of msg.to) participants.add(to);
    }

    threads.push({
      threadId,
      accountId,
      subject: msgs[0].subject,
      participants: Array.from(participants),
      messageCount: msgs.length,
      messages: msgs,
    });
  }

  return threads;
}

/**
 * Get a deterministic thread ID for a message by finding the root message-id
 * in its References chain.
 */
export function getThreadId(message: EmailMessage): string {
  if (message.references.length > 0) {
    return message.references[0];
  }
  if (message.inReplyTo) {
    return message.inReplyTo;
  }
  return message.messageId;
}
