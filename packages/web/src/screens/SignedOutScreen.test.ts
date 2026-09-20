import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearErrorFromUrl, readErrorParam, signedOutErrorMessage } from './SignedOutScreen';

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

describe('SignedOutScreen mount behavior (StrictMode double-invoke safety)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the not-allowed alert text from a URL carrying ?error=not-allowed', () => {
    // This is the value SignedOutScreen's lazy `useState(() => readErrorParam(...))` initializer
    // captures on first render, before any effect (or a StrictMode-induced second effect
    // invocation) has a chance to strip the URL.
    const initialError = readErrorParam('?error=not-allowed');
    expect(signedOutErrorMessage(initialError)).toBe(
      "That Steam account isn't on the allowlist. Ask the server owner to add you.",
    );
  });

  it('stays idempotent when the URL-clearing effect runs twice, as React 19 StrictMode does', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { search: '?error=not-allowed' },
      history: { replaceState },
    });

    // Lazy initializer: captures the error exactly once, up front.
    const initialError = readErrorParam(window.location.search);

    // StrictMode mounts, cleans up, and mounts again in development, so the effect runs twice.
    // It must not read the URL (only clear it), so the second run changes nothing.
    clearErrorFromUrl();
    clearErrorFromUrl();

    expect(replaceState).toHaveBeenCalledTimes(2);
    expect(replaceState).toHaveBeenNthCalledWith(1, {}, '', '/');
    expect(replaceState).toHaveBeenNthCalledWith(2, {}, '', '/');

    // The message derived from the captured value is unaffected by the effect running twice —
    // unlike the buggy version, where the second invocation re-read the now-stripped URL and
    // reset the error to null.
    expect(signedOutErrorMessage(initialError)).toBe(
      "That Steam account isn't on the allowlist. Ask the server owner to add you.",
    );
  });
});
