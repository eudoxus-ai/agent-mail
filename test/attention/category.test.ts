import { describe, it, expect } from 'vitest';
import { classifyCategory } from '../../src/attention/category.js';

describe('classifyCategory', () => {
  it('newsletter when list headers present, neutral subject', () => {
    expect(classifyCategory({
      list_id: '<news.example.com>',
      list_unsubscribe: 'http://x',
      subject: 'Weekly update',
    })).toBe('newsletter');
  });

  it('promotional on price/sale/discount subject', () => {
    expect(classifyCategory({
      list_id: null, list_unsubscribe: null,
      subject: '50% off today only',
    })).toBe('promotional');
  });

  it('transactional for receipts/orders/invoices', () => {
    expect(classifyCategory({
      list_id: null, list_unsubscribe: null,
      subject: 'Your receipt from Stripe',
    })).toBe('transactional');
    expect(classifyCategory({
      list_id: null, list_unsubscribe: null,
      subject: 'Order shipped',
    })).toBe('transactional');
  });

  it('notification on alert/security/2fa subjects when no list headers', () => {
    expect(classifyCategory({
      list_id: null, list_unsubscribe: null,
      subject: 'Security alert: new sign-in',
    })).toBe('notification');
  });

  it('personal when no list headers and neutral subject', () => {
    expect(classifyCategory({
      list_id: null, list_unsubscribe: null,
      subject: 'lunch tomorrow?',
    })).toBe('personal');
  });

  it('transactional wins over newsletter when both signals present', () => {
    expect(classifyCategory({
      list_id: '<list.example.com>',
      list_unsubscribe: 'http://x',
      subject: 'Your invoice #4242',
    })).toBe('transactional');
  });

  it('promotional wins over newsletter when both signals present', () => {
    expect(classifyCategory({
      list_id: '<list.example.com>',
      list_unsubscribe: 'http://x',
      subject: '70% off shoes — limited time',
    })).toBe('promotional');
  });

  it('promotional on Black Friday and Cyber Monday subjects', () => {
    for (const subject of ['Black Friday starts now', 'CYBER MONDAY: last chance', 'Up to 40%off everything']) {
      expect(classifyCategory({ list_id: null, list_unsubscribe: null, subject })).toBe('promotional');
    }
  });

  it.each([
    'noreply@service.example',
    'no-reply@service.example',
    'no_reply@service.example',
    'donotreply@service.example',
    'do-not-reply@service.example',
    'notifications@github.example',
    'notification@service.example',
    'MAILER-DAEMON@mx.example',
    'postmaster@mx.example',
    'bounce@mail.example',
    'bounces+12345@mail.example',
    'alerts@bank.example',
  ])('notification for an automated sender that would otherwise look personal: %s', (from_address) => {
    expect(
      classifyCategory({ list_id: null, list_unsubscribe: null, subject: 'Hello there', from_address })
    ).toBe('notification');
  });

  it('personal for people whose names merely resemble those words', () => {
    for (const from_address of ['bouncer@club.example', 'norah@example.com', 'alice@notifications.example']) {
      expect(
        classifyCategory({ list_id: null, list_unsubscribe: null, subject: 'Hello there', from_address })
      ).toBe('personal');
    }
  });

  it('keeps the stronger signals ahead of the sender', () => {
    const from_address = 'noreply@shop.example';
    expect(
      classifyCategory({ list_id: null, list_unsubscribe: null, subject: 'Your receipt', from_address })
    ).toBe('transactional');
    expect(
      classifyCategory({ list_id: '<news.shop.example>', list_unsubscribe: null, subject: 'Weekly', from_address })
    ).toBe('newsletter');
  });
});
