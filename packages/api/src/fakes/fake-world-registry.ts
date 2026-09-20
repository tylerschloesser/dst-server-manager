// In-memory WorldRegistry fake (docs/control-plane.md §5.1, §5.5): seeded with `test-a`/`test-b`
// by `local.ts` (decisions §16.25); tests seed whatever they need.
import type { WorldRegistryItem } from '@dst/shared';

import type { WorldRegistry } from '../ports';

export class FakeWorldRegistry implements WorldRegistry {
  private worlds = new Map<string, WorldRegistryItem>();

  constructor(initial: WorldRegistryItem[] = []) {
    for (const world of initial) this.worlds.set(world.worldId, world);
  }

  add(world: WorldRegistryItem): void {
    this.worlds.set(world.worldId, world);
  }

  clear(): void {
    this.worlds.clear();
  }

  async list(): Promise<WorldRegistryItem[]> {
    return [...this.worlds.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async get(worldId: string): Promise<WorldRegistryItem | null> {
    return this.worlds.get(worldId) ?? null;
  }
}

export function testWorld(
  overrides: Partial<WorldRegistryItem> & { worldId: string },
): WorldRegistryItem {
  return {
    pk: 'WORLD',
    sk: overrides.worldId,
    displayName: overrides.worldId,
    serverName: overrides.worldId,
    hasCaves: true,
    idleMinutes: 30,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    ...overrides,
  };
}
