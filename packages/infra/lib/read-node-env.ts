// Parses packages/supervisor/assets/node.env (decisions §16.38, docs/infra.md §3.6): exactly two
// `KEY=value` lines, no quotes, no `export`, no comments — `NODE_VERSION=v22.x.y` and
// `NODE_SHA256=<64 lowercase hex>`. Read from the directory of `userDataPath` (§1.1) so one `-c
// userDataPath=…` flag moves both files together.
import * as fs from 'node:fs';

export interface NodeEnv {
  version: string;
  sha256: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const KNOWN_KEYS = new Set(['NODE_VERSION', 'NODE_SHA256']);

export function readNodeEnv(filePath: string): NodeEnv {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Ignore a trailing newline (or other trailing whitespace) without being lenient about
  // anything else in the file.
  const lines = raw.replace(/\s+$/, '').split('\n');

  const entries = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq < 0) {
      throw new Error(`readNodeEnv(${filePath}): malformed line (no "="): ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`readNodeEnv(${filePath}): unknown key ${JSON.stringify(key)}`);
    }
    if (entries.has(key)) {
      throw new Error(`readNodeEnv(${filePath}): duplicate key ${JSON.stringify(key)}`);
    }
    entries.set(key, value);
  }

  const version = entries.get('NODE_VERSION');
  const sha256 = entries.get('NODE_SHA256');
  if (version === undefined || sha256 === undefined) {
    throw new Error(`readNodeEnv(${filePath}): missing NODE_VERSION or NODE_SHA256`);
  }
  if (!SHA256_RE.test(sha256)) {
    throw new Error(
      `readNodeEnv(${filePath}): NODE_SHA256 must be 64 lowercase hex characters, got ${JSON.stringify(sha256)}`,
    );
  }

  return { version, sha256 };
}
