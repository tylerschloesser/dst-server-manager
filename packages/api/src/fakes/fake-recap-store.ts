// In-memory ObjectReader + the RecapStore built on it (docs/control-plane.md §5.6). The fake
// implements the object layer, not the RecapStore itself, so local dev and e2e run the same scan
// (`recaps/store.ts`) the S3 adapter does: newest first, invalid digests skipped.
import type { ObjectReader, RecapStore } from '../ports';
import { createRecapStore } from '../recaps/store';
import { recapFixtureObjects } from './recap-fixture';

export class FakeObjectReader implements ObjectReader {
  constructor(readonly objects: Map<string, string> = new Map()) {}

  async listPrefixes(prefix: string): Promise<string[]> {
    const out = new Set<string>();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const slash = key.indexOf('/', prefix.length);
      if (slash !== -1) out.add(key.slice(0, slash + 1));
    }
    return [...out].sort(); // S3 returns CommonPrefixes in ascending UTF-8 order
  }

  async getText(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }
}

/** A RecapStore over the synthetic fixture (`test-a` has two valid recaps, `test-b` none). */
export function createFakeRecapStore(objects = new FakeObjectReader(recapFixtureObjects())): {
  store: RecapStore;
  objects: FakeObjectReader;
} {
  return { store: createRecapStore(objects), objects };
}
