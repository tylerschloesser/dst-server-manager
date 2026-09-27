import { describe, expect, it } from 'vitest';

import { LuaRaw, luaString, toLua } from '../test-support/synthetic';
import type { LuaValue } from '../test-support/synthetic';
import { SaveFormatError, evalLuaTable, stripTrailingNul } from './lua';

const ret = (v: LuaValue): string => `return ${toLua(v)}`;

describe('stripTrailingNul', () => {
  it('removes every trailing NUL and nothing else', () => {
    expect(stripTrailingNul('return {}\0')).toBe('return {}');
    expect(stripTrailingNul('return {}\0\0\0')).toBe('return {}');
    expect(stripTrailingNul('a\0b')).toBe('a\0b');
    expect(stripTrailingNul('')).toBe('');
  });
});

describe('evalLuaTable', () => {
  it('evaluates a table chunk into plain JSON data', async () => {
    const v = await evalLuaTable('return {a=1,b="two",c=true,d={x=1.5}}');
    expect(v).toEqual({ a: 1, b: 'two', c: true, d: { x: 1.5 } });
  });

  it('accepts the world-file form with a local and a trailing NUL', async () => {
    const v = await evalLuaTable('local savedata = {n=3}\nreturn savedata\0');
    expect(v).toEqual({ n: 3 });
  });

  it('runs the chunk in an empty environment: os/io/require/print are unreachable', async () => {
    for (const name of ['os', 'io', 'require', 'print', 'load', 'string']) {
      await expect(evalLuaTable(`return {x=${name}}`)).resolves.toEqual({});
    }
    // Calling them fails instead of executing (and never reaches the host).
    for (const call of [
      'os.execute("true")',
      'io.open("/etc/passwd")',
      'require("os")',
      'print("hi")',
    ]) {
      await expect(evalLuaTable(`local _ = ${call} return {}`)).rejects.toBeInstanceOf(
        SaveFormatError,
      );
    }
  });

  it('refuses precompiled bytecode and garbage', async () => {
    await expect(evalLuaTable('\x1bLuaT\0\x19\x93\r\n\x1a\n')).rejects.toBeInstanceOf(
      SaveFormatError,
    );
    await expect(evalLuaTable('this is not lua at all {')).rejects.toBeInstanceOf(SaveFormatError);
    await expect(evalLuaTable('')).rejects.toThrow(/expected a table/);
  });

  it('refuses a chunk that does not return a table', async () => {
    await expect(evalLuaTable('return 42')).rejects.toThrow(/returned number, expected a table/);
    await expect(evalLuaTable('return "x"')).rejects.toThrow(/returned string/);
    await expect(evalLuaTable('return nil')).rejects.toThrow(/returned nil/);
  });

  it('prefixes errors with the chunk name', async () => {
    await expect(evalLuaTable('return 1', 'after/master/world')).rejects.toThrow(
      /^after\/master\/world: /,
    );
  });

  it('turns a sequence into an array and a sparse slot table into an object keyed by slot', async () => {
    const seq = await evalLuaTable(ret({ s: ['a', 'b', 'c'] }));
    expect(seq).toEqual({ s: ['a', 'b', 'c'] });
    const sparse = (await evalLuaTable(
      ret({
        items: new Map([
          [1, 'log'],
          [6, 'axe'],
        ]),
      }),
    )) as { items: Record<string, string> };
    expect(sparse.items).toEqual({ '1': 'log', '6': 'axe' });
    expect(Array.isArray(sparse.items)).toBe(false);
    // An empty table is an (empty) object, never an array.
    expect(await evalLuaTable('return {e={}}')).toEqual({ e: {} });
  });

  it('encodes NaN and infinities as null, integers exactly and floats round-trip', async () => {
    const v = (await evalLuaTable(
      ret({ nan: NaN, inf: Infinity, ninf: -Infinity, i: 9007199254740991, f: 0.1 }),
    )) as Record<string, unknown>;
    expect(v).toEqual({ nan: null, inf: null, ninf: null, i: 9007199254740991, f: 0.1 });
  });

  it('round-trips strings with quotes, backslashes, newlines, control chars and UTF-8', async () => {
    const samples = [
      'plain',
      'she said "hi"',
      'back\\slash',
      'line1\nline2\r\n',
      'tab\there',
      'bell\x07 nul-free \x01\x1f del\x7f',
      'Wörtchen – ünïcödé ☃ 🦀',
      '',
    ];
    const v = (await evalLuaTable(`return {${samples.map(luaString).join(',')}}`)) as string[];
    expect(v).toEqual(samples);
  });

  it('refuses functions and other non-data values', async () => {
    await expect(evalLuaTable(ret({ f: new LuaRaw('function() end') }))).rejects.toThrow(
      /unsupported value of type function/,
    );
  });

  it('refuses nesting deeper than 64', async () => {
    const deep = '{'.repeat(70) + '}'.repeat(70);
    await expect(evalLuaTable(`return ${deep}`)).rejects.toThrow(/nesting deeper than 64/);
  });

  it('runs a runtime error in the chunk as SaveFormatError', async () => {
    await expect(evalLuaTable('error("boom") return {}')).rejects.toThrow(/lua eval failed/);
  });
});
