// Generates packages/recap/src/data/game-data.json from the game's own scripts
// (docs/decisions.md §18): the placeable-recipe list (what "built" means) and the English display
// names (`STRINGS.NAMES`, `STRINGS.CHARACTER_NAMES`). The output is committed and hand-reviewed;
// it holds prefab names and item nouns only, nothing from any save. Re-run after a DST update that
// adds structures:
//
//   pnpm tsx scripts/gen-recap-data.ts --scripts-zip <.../data/databundles/scripts.zip>
//
// `scripts.zip` is inside the cached `binaries/dst-binaries.tar.zst` (docs/research/
// save-anatomy.md §8 shows how to extract just that file). Never commit scripts.zip or anything
// else from the binaries.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { LuaFactory } from 'wasmoon';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../packages/recap/src/data/game-data.json');

const HELP = `Usage: pnpm tsx scripts/gen-recap-data.ts (--scripts-zip <file> | --scripts-dir <dir>) [--build-id <id>] [--out <file>]

Reads recipes.lua and strings.lua from the DST dedicated server's scripts and writes the
placeable-recipe list and display-name table the session digest uses (default output:
packages/recap/src/data/game-data.json). Offline; no AWS, no network.

  --scripts-zip <file>  data/databundles/scripts.zip from the cached binaries (needs \`unzip\`)
  --scripts-dir <dir>   an already-extracted directory that contains scripts/recipes.lua
  --build-id <id>       DST build id to record in the output (e.g. 24700372)
  --out <file>          output path
  --help                this text
`;

interface Args {
  zip: string | null;
  dir: string | null;
  buildId: string | null;
  out: string;
}

function parseArgs(argv: string[]): Args | 'help' {
  const args: Args = { zip: null, dir: null, buildId: null, out: OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') return 'help';
    else if (a === '--scripts-zip') args.zip = next();
    else if (a === '--scripts-dir') args.dir = next();
    else if (a === '--build-id') args.buildId = next();
    else if (a === '--out') args.out = path.resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if ((args.zip === null) === (args.dir === null)) {
    throw new Error('pass exactly one of --scripts-zip or --scripts-dir');
  }
  return args;
}

async function readScript(args: Args, name: string): Promise<string> {
  if (args.dir !== null) return readFile(path.join(args.dir, 'scripts', name), 'utf8');
  const { stdout } = await execFileAsync('unzip', ['-p', args.zip!, `scripts/${name}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

// A sandbox in which every unknown global is a harmless "anything" value: indexing, calling,
// concatenating or doing arithmetic on it yields another one. recipes.lua / strings.lua only need
// their constructors to *run*; we capture the Recipe2 calls and read STRINGS afterwards.
const SANDBOX = String.raw`
local anything
local mt = {}
mt.__index = function() return anything end
mt.__call = function() return anything end
mt.__concat = function() return "" end
mt.__add = function() return 0 end
mt.__sub = mt.__add
mt.__mul = mt.__add
mt.__div = mt.__add
mt.__unm = function() return 0 end
mt.__len = function() return 0 end
mt.__eq = function() return false end
mt.__lt = function() return false end
mt.__le = function() return false end
anything = setmetatable({}, mt)

local recipes = {}
local function capture(name, ingredients, tech, config)
  if type(name) == "string" then
    local c = type(config) == "table" and config or {}
    recipes[#recipes + 1] = {
      name = name,
      product = type(c.product) == "string" and c.product or name,
      placer = type(c.placer) == "string" and c.placer or nil,
    }
  end
  return anything
end

local env = setmetatable({}, { __index = function(_, k)
  local std = ({ string = string, table = table, math = math, pairs = pairs, ipairs = ipairs,
    type = type, tostring = tostring, tonumber = tonumber, select = select, next = next,
    setmetatable = setmetatable, getmetatable = getmetatable, rawget = rawget, rawset = rawset,
    unpack = table.unpack, assert = assert, error = error, pcall = pcall })[k]
  if std ~= nil then return std end
  return anything
end })
env._G = env
env.require = function() return anything end
env.Recipe = capture
env.Recipe2 = capture
env.DeconstructRecipe = function() return anything end
env.Class = function() return anything end
-- The one global recipes.lua uses as a loop bound; any number works, we skip those recipes anyway.
env.NUM_HALLOWEEN_PUMPKINCARVERS = 0
-- recipes.lua ends with a self-check over the real recipe registry; give it an empty one.
env.AllRecipes = {}
env.CRAFTING_FILTERS = {}

local function run(src, name)
  local fn = assert(load(src, name, "t", env))
  fn()
end
run(RECIPES_SRC, "recipes")
run(STRINGS_SRC, "strings")

local names = {}
for k, v in pairs(rawget(env, "STRINGS").NAMES) do
  if type(k) == "string" and type(v) == "string" then names[string.lower(k)] = v end
end
local chars = {}
for k, v in pairs(rawget(env, "STRINGS").CHARACTER_NAMES) do
  if type(k) == "string" and type(v) == "string" then chars[string.lower(k)] = v end
end
return { recipes = recipes, names = names, characters = chars }
`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const [recipesSrc, stringsSrc] = await Promise.all([
    readScript(parsed, 'recipes.lua'),
    readScript(parsed, 'strings.lua'),
  ]);

  const lua = await new LuaFactory().createEngine({ openStandardLibs: true });
  lua.global.set('RECIPES_SRC', recipesSrc);
  lua.global.set('STRINGS_SRC', stringsSrc);
  const result = (await lua.doString(SANDBOX)) as {
    recipes: Record<string, { name: string; product: string; placer?: string }>;
    names: Record<string, string>;
    characters: Record<string, string>;
  };
  lua.global.close();

  const recipes = Object.values(result.recipes);
  // "Built" means a recipe placed with a placer (a structure), keyed by the prefab it creates.
  const placeables: Record<string, string> = {};
  for (const r of recipes) {
    if (r.placer !== undefined) placeables[r.product] = r.name;
  }
  const recipeProducts: Record<string, string> = {};
  for (const r of recipes) {
    if (r.product !== r.name) recipeProducts[r.name] = r.product;
  }
  const sorted = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

  const out = {
    comment:
      'Generated by scripts/gen-recap-data.ts from the DST dedicated server scripts. Do not edit by hand.',
    buildId: parsed.buildId,
    placeables: sorted(placeables),
    recipeProducts: sorted(recipeProducts),
    characters: sorted(result.characters),
    names: sorted(result.names),
  };
  await writeFile(parsed.out, JSON.stringify(out, null, 1) + '\n');
  process.stdout.write(
    `wrote ${parsed.out}: ${Object.keys(placeables).length} placeables, ` +
      `${Object.keys(result.names).length} names, ${Object.keys(result.characters).length} characters\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`gen-recap-data: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
