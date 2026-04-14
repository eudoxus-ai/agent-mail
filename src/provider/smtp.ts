import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { ResolvedAccount } from '../types.js';

export function createSmtpTransport(account: ResolvedAccount): Transporter {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.port === 465,
    auth: {
      user: account.auth.user,
      pass: account.auth.pass,
    },
  });
}

export interface SendMailOptions {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface DraftMessageOptions {
  from: string;
  to: string | string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function normalizeAddressList(value: string | string[]): string {
  return (Array.isArray(value) ? value : [value])
    .map((entry) => sanitizeHeaderValue(entry))
    .filter(Boolean)
    .join(', ');
}

export function buildDraftMessage(options: DraftMessageOptions): Buffer {
  const lines = [
    `From: ${sanitizeHeaderValue(options.from)}`,
    `To: ${normalizeAddressList(options.to)}`,
    `Subject: ${sanitizeHeaderValue(options.subject)}`,
    options.inReplyTo
      ? `In-Reply-To: ${sanitizeHeaderValue(options.inReplyTo)}`
      : '',
    options.references && options.references.length > 0
      ? `References: ${options.references
          .map((entry) => sanitizeHeaderValue(entry))
          .join(' ')}`
      : '',
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    options.text.replace(/\r?\n/g, '\r\n'),
  ].filter(Boolean);

  return Buffer.from(lines.join('\r\n'), 'utf-8');
}

export async function sendMail(
  transport: Transporter,
  options: SendMailOptions
): Promise<{ messageId: string }> {
  const info = await transport.sendMail({
    from: options.from,
    to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
    cc: options.cc
      ? Array.isArray(options.cc)
        ? options.cc.join(', ')
        : options.cc
      : undefined,
    bcc: options.bcc
      ? Array.isArray(options.bcc)
        ? options.bcc.join(', ')
        : options.bcc
      : undefined,
    subject: options.subject,
    text: options.text,
    html: options.html,
    inReplyTo: options.inReplyTo,
    references: options.references?.join(' '),
  });

  return { messageId: info.messageId };
}
