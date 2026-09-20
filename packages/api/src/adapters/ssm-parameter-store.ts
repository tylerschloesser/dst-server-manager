// ParameterStore adapter (docs/control-plane.md §5.1): SSM `GetParameter` with decryption, cached
// `PARAM_CACHE_MS` per (name, region) — used by `GET /api/worlds` to read the cluster password
// from `/dst/cluster-password` in us-west-2 (docs/decisions.md §16.17).
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { PARAM_CACHE_MS } from '@dst/shared';

import type { ParameterStore } from '../ports';

interface CacheEntry {
  value: string;
  fetchedAtMs: number;
}

export function createSsmParameterStore(): ParameterStore {
  const clients = new Map<string, SSMClient>();
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<string>>();

  function clientFor(region: string): SSMClient {
    let client = clients.get(region);
    if (client === undefined) {
      client = new SSMClient({ region });
      clients.set(region, client);
    }
    return client;
  }

  return {
    async get(name: string, region: string): Promise<string> {
      const key = `${region}:${name}`;
      const cached = cache.get(key);
      const now = Date.now();
      if (cached !== undefined && now - cached.fetchedAtMs < PARAM_CACHE_MS) {
        return cached.value;
      }

      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async () => {
        try {
          const res = await clientFor(region).send(
            new GetParameterCommand({ Name: name, WithDecryption: true }),
          );
          const value = res.Parameter?.Value;
          if (value === undefined || value === '') {
            throw new Error(`missing parameter: ${name}`);
          }
          cache.set(key, { value, fetchedAtMs: Date.now() });
          return value;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, promise);
      return promise;
    },
  };
}
