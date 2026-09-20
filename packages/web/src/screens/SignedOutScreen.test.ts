import { describe, expect, it } from 'vitest';
import { signedOutErrorMessage } from './SignedOutScreen';

describe('signedOutErrorMessage', () => {
  it('returns null when there is no error', () => {
    expect(signedOutErrorMessage(null)).toBeNull();
  });

  it('explains the allowlist rejection', () => {
    expect(signedOutErrorMessage('not-allowed')).toBe(
      "That Steam account isn't on the allowlist. Ask the server owner to add you.",
    );
  });

  it('gives a generic message for any other non-empty error', () => {
    expect(signedOutErrorMessage('steam-unavailable')).toBe(
      "Sign-in didn't work. Please try again.",
    );
    expect(signedOutErrorMessage('login-failed')).toBe("Sign-in didn't work. Please try again.");
  });
});
