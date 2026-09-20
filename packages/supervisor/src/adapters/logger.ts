// @dst/supervisor adapters: structured logging with secret redaction (docs/game-server.md §10).
// Every revealed `Secret` value (the Klei token, the cluster password) is substring-redacted from
// every line before it is written, so a call site that forgets to avoid a secret still cannot leak
// it into `/var/log/dst/supervisor.log` (which is itself uploaded to S3 at stop, decisions §16.22).
import { revealedSecretValues } from './secret';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function redact(line: string): string {
  let out = line;
  for (const secret of revealedSecretValues()) {
    if (secret.length === 0) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

function safeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const errorLike = fields['error'];
  if (errorLike instanceof Error) {
    return { ...fields, error: errorLike.message };
  }
  return fields;
}

function write(level: string, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...safeFields(fields),
  });
  process.stdout.write(redact(line) + '\n');
}

/** `StandardOutput=append:/var/log/dst/supervisor.log` on `dst-supervisor.service` is what turns
 *  every `process.stdout.write` here into that file (docs/game-server.md §6). */
export function createLogger(): Logger {
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
