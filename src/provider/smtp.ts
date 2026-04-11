import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AccountConfig } from '../types.js';

export function createSmtpTransport(account: AccountConfig): Transporter {
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
