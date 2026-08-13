import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetSchema } from './target.js';

/** Inline base64 is capped well below the on-disk limit — it costs tokens. */
export const INLINE_MAX_BYTES = 256 * 1024;

export const getAttachmentTool: ToolDefinition = {
  name: 'get_attachment',
  description:
    'Download one attachment from a message and stage it on local disk. Attachment metadata (part_id, filename, mime_type, size) is returned by search_threads and read_thread — pass the `part_id` from there. By default the payload is written to a private staging directory and the response contains its `path`, which you can open with your own file tools; the file is deleted after 7 days. Set `inline: true` to receive base64 content in the response instead, which is capped at 256 KB and costs a lot of tokens — prefer the path. Attachment payloads are not cached locally, so this always fetches from the mail server.',
  inputSchema: z.object({
    target: TargetSchema.describe('Account-qualified message reference'),
    part_id: z
      .string()
      .min(1)
      .describe('BODYSTRUCTURE part id, from the `attachments` metadata on a message'),
    inline: z
      .boolean()
      .optional()
      .describe(
        'Return base64 content in the response instead of writing to disk. Fails for payloads over 256 KB. Default false.'
      ),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
