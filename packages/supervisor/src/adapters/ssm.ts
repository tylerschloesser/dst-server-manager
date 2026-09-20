// @dst/supervisor adapters: SSM secrets (docs/game-server.md §5, §10; docs/control-plane.md §1.1).
// Both parameters live in us-west-2 (the client passed in is already scoped there). Cached for
// `PARAM_CACHE_MS` so a hot loop (heartbeats, per-shard console writes) does not hammer SSM; a
// `Secret` never reveals its value except through `.reveal()`, called only by the INI writer and
// the token-file writer (`tasks/restore.ts`).
import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { PARAM_CACHE_MS, PARAM_CLUSTER_PASSWORD, PARAM_KLEI_TOKEN } from '@dst/shared';

import type { Secret, SecretPort } from '../core';
import { createSecret } from './secret';

interface CacheEntry {
  readonly value: Secret;
  readonly fetchedAt: number;
}

export function createSsmAdapter(client: SSMClient): SecretPort {
  const cache = new Map<string, CacheEntry>();

  async function getParam(name: string): Promise<Secret> {
    const cached = cache.get(name);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PARAM_CACHE_MS) return cached.value;

    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = res.Parameter?.Value;
    if (value === undefined) throw new Error(`SSM parameter ${name} has no value`);

    const secret = createSecret(value);
    cache.set(name, { value: secret, fetchedAt: now });
    return secret;
  }

  return {
    getClusterPassword: () => getParam(PARAM_CLUSTER_PASSWORD),
    getKleiToken: () => getParam(PARAM_KLEI_TOKEN),
  };
}
