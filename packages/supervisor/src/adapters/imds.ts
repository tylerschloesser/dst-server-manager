// @dst/supervisor adapters: IMDSv2 identity (docs/game-server.md §8). `PUT /latest/api/token`
// (TTL 21600s), 2 s timeout, 3 retries; no `ec2:DescribeTags` fallback — the instance role has no
// `ec2:*` permission at all, so a failed read here is fatal (the caller halts and lets the
// reaper's boot-grace rule collect the instance). Uses Node 22's global `fetch`, not an AWS SDK
// client — IMDS is a plain local HTTP endpoint, and `@aws-sdk/client-ec2` is explicitly not a
// dependency of this package (docs/game-server.md §1).
import type { MetaPort } from '../core';

const IMDS_BASE = 'http://169.254.169.254';
const TOKEN_TTL_SECONDS = 21_600;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 3;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('IMDS request failed');
}

async function fetchToken(): Promise<string> {
  return withRetries(async () => {
    const res = await fetchWithTimeout(`${IMDS_BASE}/latest/api/token`, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': String(TOKEN_TTL_SECONDS) },
    });
    if (!res.ok) throw new Error(`IMDS token request failed: HTTP ${res.status}`);
    return res.text();
  });
}

async function fetchMeta(token: string, path: string): Promise<string> {
  return withRetries(async () => {
    const res = await fetchWithTimeout(`${IMDS_BASE}${path}`, {
      headers: { 'X-aws-ec2-metadata-token': token },
    });
    if (!res.ok) throw new Error(`IMDS ${path} failed: HTTP ${res.status}`);
    return res.text();
  });
}

export function createImdsAdapter(): MetaPort {
  return {
    async getIdentity() {
      const token = await fetchToken();
      const [instanceId, publicIp, instanceType, sessionIdTag] = await Promise.all([
        fetchMeta(token, '/latest/meta-data/instance-id'),
        fetchMeta(token, '/latest/meta-data/public-ipv4'),
        fetchMeta(token, '/latest/meta-data/instance-type'),
        fetchMeta(token, '/latest/meta-data/tags/instance/sessionId'),
      ]);
      return { instanceId, publicIp, instanceType, sessionIdTag };
    },
  };
}
