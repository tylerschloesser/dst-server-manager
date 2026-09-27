// Evaluates a DST save chunk (pure table constructors, docs/research/save-anatomy.md §2) in a real
// Lua 5.4 VM (wasmoon: Lua compiled to WASM) and hands the result to JS as JSON.
//
// Why wasmoon and not fengari (measured on the real 4.0 MB Master world file, docs/decisions.md
// §18): wasmoon 0.32 s / 156 MB RSS vs fengari 3.1 s / 525 MB for evaluate + encode.
//
// Why JSON and not wasmoon's automatic table proxying: one string crossing the WASM boundary is
// fast and has exactly-defined semantics. The encoder below decides array-vs-object the way the
// digest needs it: a table whose keys are exactly 1..n is a JSON array; anything else (including
// sparse slot tables like `items={[6]=…,[10]=…}`) is an object with stringified keys, so slot
// numbers survive.
//
// The chunk runs in an EMPTY environment (`load(src, name, 't', {})`): no `os`, `io`, `require`,
// or even `print` is reachable from save content. Mode 't' refuses precompiled bytecode.
import { LuaFactory } from 'wasmoon';

const ENCODER = String.raw`
local type, pairs, tostring, fmt, concat, gsub, byte = type, pairs, tostring, string.format, table.concat, string.gsub, string.byte
local ESC = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function str(s)
  return '"' .. gsub(s, '[%c"\\]', function(c) return ESC[c] or fmt('\\u%04x', byte(c)) end) .. '"'
end
local function enc(v, out, depth)
  if depth > 64 then error('nesting deeper than 64') end
  local t = type(v)
  if t == 'table' then
    local n, count = #v, 0
    for _ in pairs(v) do count = count + 1 end
    if n > 0 and count == n then
      out[#out + 1] = '['
      for i = 1, n do
        if i > 1 then out[#out + 1] = ',' end
        enc(v[i], out, depth + 1)
      end
      out[#out + 1] = ']'
    else
      out[#out + 1] = '{'
      local first = true
      for k, val in pairs(v) do
        if not first then out[#out + 1] = ',' end
        first = false
        out[#out + 1] = str(tostring(k))
        out[#out + 1] = ':'
        enc(val, out, depth + 1)
      end
      out[#out + 1] = '}'
    end
  elseif t == 'string' then
    out[#out + 1] = str(v)
  elseif t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then out[#out + 1] = 'null'
    elseif math.type(v) == 'integer' then out[#out + 1] = fmt('%d', v)
    else out[#out + 1] = fmt('%.17g', v) end
  elseif t == 'boolean' then
    out[#out + 1] = tostring(v)
  elseif t == 'nil' then
    out[#out + 1] = 'null'
  else
    error('unsupported value of type ' .. t)
  end
end
return function(v) local out = {} enc(v, out, 0) return concat(out) end
`;

const RUNNER = `
local encode = (function() ${ENCODER} end)()
local fn, err = load(DST_SRC, DST_NAME, 't', {})
if not fn then error('lua load failed: ' .. tostring(err)) end
local ok, value = pcall(fn)
if not ok then error('lua eval failed: ' .. tostring(value)) end
if type(value) ~= 'table' then error('chunk returned ' .. type(value) .. ', expected a table') end
return encode(value)
`;

export class SaveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveFormatError';
  }
}

let factory: LuaFactory | null = null;

/** The WASM binary's location can be overridden for the Lambda bundle (esbuild copies
 *  `glue.wasm` next to `digest.js`; see esbuild.mjs). */
export function configureLuaWasm(wasmPath: string | undefined): void {
  factory = new LuaFactory(wasmPath);
}

/** Strips the trailing NUL DST writes after `return savedata` (Lua refuses the chunk with it). */
export function stripTrailingNul(src: string): string {
  let end = src.length;
  while (end > 0 && src.charCodeAt(end - 1) === 0) end--;
  return src.slice(0, end);
}

/** Evaluates `src` (a `return {…}` chunk) and returns it as plain JS data. Throws
 *  `SaveFormatError` on anything unexpected — never a partial value. */
export async function evalLuaTable(src: string, name = 'save'): Promise<unknown> {
  factory ??= new LuaFactory();
  const lua = await factory.createEngine({ openStandardLibs: true });
  try {
    lua.global.set('DST_SRC', stripTrailingNul(src));
    lua.global.set('DST_NAME', name);
    const json: unknown = await lua.doString(RUNNER);
    if (typeof json !== 'string') throw new SaveFormatError(`${name}: encoder returned no string`);
    return JSON.parse(json) as unknown;
  } catch (err) {
    if (err instanceof SaveFormatError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SaveFormatError(`${name}: ${message}`);
  } finally {
    lua.global.close();
  }
}
