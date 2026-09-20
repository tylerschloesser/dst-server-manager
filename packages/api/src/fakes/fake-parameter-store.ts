// In-memory ParameterStore fake (docs/control-plane.md §5.5): `local.ts` wires
// `/dst/cluster-password` -> `localpass1`.
import type { ParameterStore } from '../ports';

export class FakeParameterStore implements ParameterStore {
  private values: Map<string, string>;

  constructor(seed: Record<string, string> = {}) {
    this.values = new Map(Object.entries(seed));
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  async get(name: string, region: string): Promise<string> {
    const value = this.values.get(name);
    if (value === undefined) {
      throw new Error(`fake parameter not set: ${name} (${region})`);
    }
    return value;
  }
}
