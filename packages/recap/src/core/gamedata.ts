// Typed access to the committed, generated `data/game-data.json` (scripts/gen-recap-data.ts):
// which prefabs are placeable structures, and English display names.
import raw from '../data/game-data.json';

export interface GameData {
  buildId: string | null;
  /** built prefab -> recipe name, for every recipe placed with a placer */
  placeables: Record<string, string>;
  /** recipe name -> product prefab, where they differ */
  recipeProducts: Record<string, string>;
  characters: Record<string, string>;
  names: Record<string, string>;
}

export const GAME_DATA: GameData = raw as GameData;

export function isPlaceable(prefab: string): boolean {
  return Object.hasOwn(GAME_DATA.placeables, prefab);
}

/** "smallmeat_dried" -> "Small Jerky" (STRINGS.NAMES), else a readable fallback. */
export function displayName(prefab: string): string {
  const key = prefab.toLowerCase();
  if (Object.hasOwn(GAME_DATA.names, key)) return GAME_DATA.names[key]!;
  const recipe = GAME_DATA.placeables[key];
  if (recipe !== undefined && Object.hasOwn(GAME_DATA.names, recipe))
    return GAME_DATA.names[recipe]!;
  return key.replace(/_/g, ' ');
}

export function characterName(prefab: string): string {
  const key = prefab.toLowerCase();
  return Object.hasOwn(GAME_DATA.characters, key) ? GAME_DATA.characters[key]! : key;
}
