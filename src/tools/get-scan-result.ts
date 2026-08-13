import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getScanJob } from '../ledger/scan-jobs.js';

export const getScanResultTool: ToolDefinition = {
  name: 'get_scan_result',
  description:
    'Poll the result of an async scan started with `async: true` on get_overview, list_senders, or search_threads. Pass the `job_id` returned by that call. Returns `{ status: "running" }` while the scan is still in flight, `{ status: "done", result }` with the byte-identical payload the synchronous form would have produced once complete, or `{ status: "failed", error }` if the scan threw. Read-only; safe to poll repeatedly.',
  inputSchema: z.object({
    job_id: z.string().min(1).describe('The job_id returned from an async scan call.'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute(params, context) {
    const jobId = params.job_id as string;
    const job = getScanJob(context.db, jobId);
    if (!job) {
      return {
        type: 'immediate',
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, message: `scan job not found: ${jobId}` }),
          },
        ],
      };
    }

    let payload: Record<string, unknown>;
    if (job.status === 'running') {
      payload = { status: 'running' };
    } else if (job.status === 'done') {
      payload = { status: 'done', result: job.result };
    } else {
      payload = {
        status: 'failed',
        error:
          (job.error_detail && (job.error_detail.message as string)) ??
          'scan failed',
      };
    }

    return {
      type: 'immediate',
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  },
};
