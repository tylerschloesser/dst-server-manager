// In-memory ObjectReader + the RecapStore built on it (docs/control-plane.md §5.6). The fake
// implements the object layer, not the RecapStore itself, so local dev and e2e run the same scan
// (`recaps/store.ts`) the S3 adapter does: newest first, invalid digests skipped.
import type { MapStore, ObjectReader, RecapStore } from '../ports';
import { createMapStore } from '../recaps/map-store';
import { createRecapStore } from '../recaps/store';
import { recapFixtureObjects } from './recap-fixture';

export class FakeObjectReader implements ObjectReader {
  /** key -> body: text objects as strings, binary ones (map grids, trails) as bytes. */
  constructor(readonly objects: Map<string, string | Uint8Array> = new Map()) {}

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
    const v = this.objects.get(key);
    if (v === undefined) return null;
    return typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const v = this.objects.get(key);
    if (v === undefined) return null;
    return typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  }
}

/** A RecapStore (and the MapStore over the same objects) on the synthetic fixture (`test-a` has
 *  two valid recaps and a map for the dev user, `test-b` nothing). */
export function createFakeRecapStore(objects = new FakeObjectReader(recapFixtureObjects())): {
  store: RecapStore;
  maps: MapStore;
  objects: FakeObjectReader;
} {
  return { store: createRecapStore(objects), maps: createMapStore(objects), objects };
}
