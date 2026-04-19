import { describe, expect, it } from 'vitest';
import { buildApprovalUrl } from '../../src/reviewer/urls.js';

describe('buildApprovalUrl', () => {
  it('builds the expected approval URL for the default port', () => {
    expect(buildApprovalUrl(4242, 'intent-abc')).toBe(
      'http://127.0.0.1:4242/intents/intent-abc'
    );
  });

  it('honors a different reviewer port', () => {
    expect(buildApprovalUrl(5555, 'intent-abc')).toBe(
      'http://127.0.0.1:5555/intents/intent-abc'
    );
  });

  it('works with a UUID intent id', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(buildApprovalUrl(4242, uuid)).toBe(
      `http://127.0.0.1:4242/intents/${uuid}`
    );
  });
});
