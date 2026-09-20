import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { readNodeEnv } from '../lib/read-node-env';

const FIXTURE = path.resolve(__dirname, 'fixtures/node.env');

describe('readNodeEnv', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeTemp(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-infra-node-env-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'node.env');
    fs.writeFileSync(file, contents);
    return file;
  }

  it('parses the committed fixture (a placeholder, never a real digest)', () => {
    const result = readNodeEnv(FIXTURE);
    expect(result).toEqual({
      version: 'v22.0.0',
      sha256: 'a'.repeat(64),
    });
  });

  it('accepts the two keys in either order', () => {
    const file = writeTemp(`NODE_SHA256=${'b'.repeat(64)}\nNODE_VERSION=v22.1.2\n`);
    expect(readNodeEnv(file)).toEqual({ version: 'v22.1.2', sha256: 'b'.repeat(64) });
  });

  it('ignores a trailing newline', () => {
    const file = writeTemp(`NODE_VERSION=v22.0.0\nNODE_SHA256=${'c'.repeat(64)}\n\n`);
    expect(readNodeEnv(file)).toEqual({ version: 'v22.0.0', sha256: 'c'.repeat(64) });
  });

  it('throws on a one-line file (missing key)', () => {
    const file = writeTemp('NODE_VERSION=v22.0.0\n');
    expect(() => readNodeEnv(file)).toThrow();
  });

  it('throws when NODE_SHA256 is 63 characters', () => {
    const file = writeTemp(`NODE_VERSION=v22.0.0\nNODE_SHA256=${'d'.repeat(63)}\n`);
    expect(() => readNodeEnv(file)).toThrow();
  });

  it('throws on an unknown key', () => {
    const file = writeTemp(`NODE_VERSION=v22.0.0\nNODE_SHA256=${'a'.repeat(64)}\nEXTRA=1\n`);
    expect(() => readNodeEnv(file)).toThrow();
  });

  it('throws on a duplicate key', () => {
    const file = writeTemp(
      `NODE_VERSION=v22.0.0\nNODE_VERSION=v22.0.1\nNODE_SHA256=${'a'.repeat(64)}\n`,
    );
    expect(() => readNodeEnv(file)).toThrow();
  });
});
