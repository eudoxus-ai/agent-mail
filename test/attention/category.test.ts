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
});
