// @dst/supervisor adapters: the `Secret` wrapper (docs/game-server.md §10 "Secret hygiene,
// enforced in code"). `adapters/ssm.ts` is the only place a `Secret` is constructed; `.reveal()`
// is called only by the INI writer and the token-file writer (`tasks/restore.ts`). Every revealed
// value is remembered here so `adapters/logger.ts` can redact it by substring from every log line,
// even one written somewhere that forgot to avoid it.
import type { Secret } from '../core';

const revealedValues = new Set<string>();

export function createSecret(value: string): Secret {
  return {
    reveal(): string {
      if (value.length > 0) revealedValues.add(value);
      return value;
    },
    toString(): '***' {
      return '***';
    },
    toJSON(): '***' {
      return '***';
    },
  };
}

/** Every value any `Secret` in this process has ever revealed. Read by `adapters/logger.ts`. */
export function revealedSecretValues(): readonly string[] {
  return [...revealedValues];
}
