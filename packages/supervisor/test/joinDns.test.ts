// The stable join record (docs/decisions.md §17, docs/game-server.md §8, §9): what gets written,
// and — the part that actually matters — the proof that *every* path that powers the instance off
// sinks it, while an in-place switch does not. The first two are ordinary unit tests over
// `tasks/joinDns.ts`; the last two are assertions about `src/index.ts`'s source, because
// importing that module runs `runSupervisor()` (and `finishStop`'s switch branch is reachable
// only through the whole loop). Structure, not behaviour — but it is the structure the invariant
// is stated as, and it fails loudly the day someone adds a ninth poweroff.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JOIN_DNS_SINK_IP } from '@dst/shared';
import { describe, expect, it } from 'vitest';

import { FakeDns } from '../src/adapters/route53';
import type { Logger } from '../src/adapters/logger';
import type { HostPort } from '../src/core';
import { haltNow, publishJoinRecord } from '../src/tasks/joinDns';

function fakeLogger(): Logger & { readonly events: string[] } {
  const events: string[] = [];
  const record = (event: string) => events.push(event);
  return { events, debug: record, info: record, warn: record, error: record };
}

function fakeHost(): HostPort & { readonly shutdowns: { count: number } } {
  const shutdowns = { count: 0 };
  return {
    shutdowns,
    shutdownNow: () => {
      shutdowns.count++;
      return Promise.resolve();
    },
  };
}

const INDEX_SRC = readFileSync(join(__dirname, '../src/index.ts'), 'utf8');

describe('publishJoinRecord', () => {
  it('points the record at this instance', async () => {
    const dns = new FakeDns();
    await publishJoinRecord({ dns, logger: fakeLogger() }, '203.0.113.10');
    expect(dns.writes).toEqual(['203.0.113.10']);
  });

  it('never throws when Route 53 fails — a boot must not depend on DNS', async () => {
    const dns = new FakeDns();
    dns.failWith(new Error('Throttling'));
    const logger = fakeLogger();
    await expect(publishJoinRecord({ dns, logger }, '203.0.113.10')).resolves.toBeUndefined();
    expect(logger.events).toContain('join_dns_failed');
  });
});

describe('haltNow', () => {
  it('sinks the record, then powers the instance off', async () => {
    const dns = new FakeDns();
    const host = fakeHost();
    await haltNow({ dns, host, logger: fakeLogger() });
    expect(dns.writes).toEqual([JOIN_DNS_SINK_IP]);
    expect(host.shutdowns.count).toBe(1);
  });

  it('still powers the instance off when Route 53 fails', async () => {
    const dns = new FakeDns();
    dns.failWith(new Error('AccessDenied'));
    const host = fakeHost();
    const logger = fakeLogger();
    await haltNow({ dns, host, logger });
    expect(host.shutdowns.count).toBe(1);
    expect(logger.events).toContain('join_dns_failed');
  });
});

describe('every poweroff goes through haltNow (docs/game-server.md §9)', () => {
  it('src/index.ts never calls shutdownNow itself', () => {
    expect(INDEX_SRC).not.toMatch(/\.shutdownNow\s*\(/);
    expect(INDEX_SRC.match(/haltNow\(deps\)/g)?.length).toBe(8);
  });

  // The switch path is the one stop that must NOT sink: same instance, same IP, the world simply
  // changes underneath a record that is already correct. Halting and switching are disjoint —
  // every `haltNow` is immediately followed by a return that ends the supervisor (`halted`, or
  // `runSupervisor`'s bare `return`), so no path can both sink the record and carry on running.
  it('halting and switching are disjoint, so an in-place switch never sinks', () => {
    for (const tail of INDEX_SRC.split('await haltNow(deps);').slice(1)) {
      const next = tail.trimStart();
      expect(next.startsWith("return { kind: 'halted' };") || next.startsWith('return;')).toBe(
        true,
      );
    }
    expect(INDEX_SRC).toContain("return { kind: 'switch', nextWorldId: next");
  });
});
