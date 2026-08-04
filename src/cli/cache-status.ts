import type { Database } from '../cache/db.js';
import type { CacheConfig } from '../cache/config.js';
import { getCoverage, isServable } from '../cache/coverage.js';

interface MailboxRow {
  account_id: string;
  mailbox: string;
  backfill_complete: number;
  oldest_date: number | null;
  last_delta_at: number | null;
  last_error: string | null;
  messages: number;
  pending_bodies: number;
}

/**
 * Render the cache's state so the question "is this up to date?" is answered on
 * the account line rather than left to be inferred.
 *
 * The verdict comes from `getCoverage` — the same check the search path uses —
 * on purpose. The previous output judged health by eye from per-mailbox
 * counters, and could therefore print "backfill complete" for an account that
 * every search treated as `unavailable`, because one mailbox had never had a
 * delta sync and that disqualifies the whole account. Two independent
 * judgements of the same thing is how status ends up reassuring while nothing
 * works.
 */
export function buildCacheStatusLines(db: Database, config: CacheConfig): string[] {
  const rows = db
    .prepare(
      `SELECT s.account_id, s.mailbox, s.backfill_complete, s.oldest_date,
              s.last_delta_at, s.last_error,
              (SELECT COUNT(*) FROM messages m
                WHERE m.account_id = s.account_id AND m.mailbox = s.mailbox) AS messages,
              (SELECT COUNT(*) FROM messages m
                WHERE m.account_id = s.account_id AND m.mailbox = s.mailbox
                  AND m.body_state = 'pending') AS pending_bodies
         FROM mailbox_state s
        ORDER BY s.account_id, s.mailbox`
    )
    .all() as unknown as MailboxRow[];

  const out: string[] = [`Local cache: mode=${config.mode}`];

  if (config.mode === 'off') {
    out.push('  Mode is off: the daemon does not sync, and nothing here is read.');
    out.push("  Turn it on with: agent-mail cache shadow");
    if (rows.length === 0) return out;
    out.push('  (state below is left over from a previous mode)');
  }

  if (rows.length === 0) {
    out.push('  No mailboxes synced yet.');
    return out;
  }

  const byAccount = new Map<string, MailboxRow[]>();
  for (const row of rows) {
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }

  for (const [accountId, mailboxes] of byAccount) {
    const coverage = getCoverage(db, [accountId], {
      freshnessWindowSeconds: config.freshnessWindowSeconds,
    });
    const neverSynced = mailboxes.filter((m) => m.last_delta_at == null);

    let verdict: string;
    if (!isServable(coverage.state)) {
      const why =
        neverSynced.length > 0
          ? `${neverSynced.length} mailbox(es) have never synced`
          : coverage.state === 'stale'
            ? 'the last sync is older than the freshness window — is the daemon running?'
            : coverage.state;
      // Both the consequence and the state name: the consequence because
      // `unavailable` alone does not tell anyone their searches are quietly
      // going elsewhere, and the state name because it is what tool responses
      // report as `cache.state`, and the two need to be correlatable.
      verdict = `NOT USABLE — ${coverage.state}: ${why}. Searches fall back to IMAP.`;
    } else {
      const oldest = Math.min(
        ...mailboxes.map((m) => m.last_delta_at ?? 0).filter((t) => t > 0)
      );
      verdict = `${coverage.state} (oldest sync ${age(Date.now() - oldest)})`;
    }

    out.push('');
    out.push(`  ${accountId} — ${verdict}`);

    const width = Math.max(...mailboxes.map((m) => m.mailbox.length));
    for (const m of mailboxes) {
      const synced = m.last_delta_at == null ? 'never synced' : `synced ${age(Date.now() - m.last_delta_at)} ago`;
      const back = m.oldest_date ? new Date(m.oldest_date).toISOString().slice(0, 10) : '—';
      const backfill = m.backfill_complete === 1 ? 'complete' : 'backfilling';
      out.push(
        `    ${m.mailbox.padEnd(width)}  ${String(m.messages).padStart(6)} msgs  ` +
          `${backfill.padEnd(11)}  back to ${back}  ${synced}`
      );
      if (m.last_error) {
        // Recorded by the sync loop on every failure and, until now, displayed
        // nowhere — so the explanation for a stalled account sat unread.
        out.push(`      ! last error: ${m.last_error}`);
      }
    }

    const pending = mailboxes.reduce((n, m) => n + Number(m.pending_bodies ?? 0), 0);
    if (pending > 0) {
      // A large number here looks like the cache is broken. It is not: sender
      // sweeps and header searches work off envelopes, which are already in.
      out.push(
        `    ${pending} message bodies still queued — envelopes are searchable now; ` +
          'this only affects full-text body search.'
      );
    }
  }

  if (config.mode === 'shadow') {
    out.push('');
    out.push(
      '  Mode is shadow: the cache is being built and compared, but it is not answering ' +
        'searches and sweeps only report what it would have caught. Switch with: ' +
        'agent-mail cache on'
    );
  }

  return out;
}

/** Durations a person can read at a glance, which raw seconds are not. */
function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
