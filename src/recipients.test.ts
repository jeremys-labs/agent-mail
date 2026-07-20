import { describe, expect, it } from 'vitest';
import { validateSingleRecipient } from './recipients.js';

describe('validateSingleRecipient', () => {
  it('rejects comma-separated recipients instead of creating an unreachable mailbox recipient', () => {
    expect(() => validateSingleRecipient('zara,marcus')).toThrow(/one agent/i);
  });

  it('returns a trimmed single recipient', () => {
    expect(validateSingleRecipient(' zara ')).toBe('zara');
  });
});
