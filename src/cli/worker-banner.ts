import type { WorkerState } from '../ledger/worker-heartbeat.js';
import { INSTALL_HINT } from '../ledger/worker-heartbeat.js';

/**
 * The line `agent-mail status` leads with when nothing is draining the queue.
 *
 * Returns null on a healthy system, deliberately: a warning that appears when
 * things are fine is a warning people learn to scroll past, and this one has to
 * still work the day it matters.
 */
export function buildWorkerBanner(state: WorkerState): string | null {
  if (state.alive) return null;

  if (state.queued_count > 0) {
    const waited = formatAge(state.oldest_queued_age_seconds ?? 0);
    return [
      '⚠  The agent-mail daemon is NOT running.',
      '',
      `   ${state.queued_count} action(s) are queued and nothing is performing them.`,
      `   The oldest has been waiting ${waited}.`,
      '',
      // The reassurance is load-bearing. Without it the natural response is to
      // re-file the work, which then runs twice once the daemon comes back.
      '   Nothing has been lost — the queue drains as soon as the daemon starts.',
      `   ${INSTALL_HINT}`,
    ].join('\n');
  }

  return [
    '⚠  The agent-mail daemon is NOT running.',
    '',
    '   Actions will be accepted and queued, but nothing will perform them.',
    `   ${INSTALL_HINT}`,
  ].join('\n');
}

function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m (${seconds}s)`;
  return `${Math.round(minutes / 60)}h (${seconds}s)`;
}
