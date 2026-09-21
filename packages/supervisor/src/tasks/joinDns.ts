// @dst/supervisor tasks: the stable join name (docs/decisions.md §17, docs/game-server.md §8, §9).
// `JOIN_HOSTNAME` follows the instance: pointed at this session's public IP once the session is
// ours, sunk to `JOIN_DNS_SINK_IP` on the way to powering off. Both writes are `UPSERT`s through
// `DnsPort`, and both are non-fatal — the state item still carries the raw `publicIp` the UI shows
// as a fallback, and DNS must never be able to block a boot or, far worse, a stop.
//
// These two functions live here rather than in `src/index.ts` so they can be unit-tested: that
// module calls `runSupervisor()` on import.
import { JOIN_DNS_SINK_IP } from '@dst/shared';

import type { DnsPort, HostPort } from '../core';
import type { Logger } from '../adapters/logger';

export interface JoinDnsDeps {
  readonly dns: DnsPort;
  readonly logger: Logger;
}

export interface HaltDeps extends JoinDnsDeps {
  readonly host: HostPort;
}

/** Point `JOIN_HOSTNAME` at this instance. Called once the session is ours (S1 claimed, or a
 *  resume onto a session that already is) and before DST starts, so the record propagates during
 *  the ~2.5 min boot instead of after it. */
export async function publishJoinRecord(deps: JoinDnsDeps, ip: string): Promise<void> {
  try {
    await deps.dns.setJoinRecord(ip);
    deps.logger.info('join_dns_published', { ip });
  } catch (err) {
    deps.logger.warn('join_dns_failed', { ip, error: String(err) });
  }
}

/**
 * The **only** way the supervisor powers the instance off: `rg 'host\.shutdownNow'
 * packages/supervisor/src` matches this function and the adapter that defines it, nothing else
 * (`test/joinDns.test.ts` asserts exactly that). Sinking the record here, on the halt path and
 * nowhere else, is what keeps an in-place world switch correct — a switch does not halt, so the
 * record keeps pointing at the instance that is still running.
 *
 * The stop *ordering* invariant is untouched (CLAUDE.md "The save is precious"): by the time
 * anything calls this, DST has saved, the save is in S3, S8 is released and the final `stopped`
 * write is done. The sink can only delay the poweroff by one API call, and never by a failed one
 * — a throw here would strand a live instance, so it is caught. Losing the sink costs a stale
 * record the reaper will fix; losing the poweroff costs a month of EC2.
 */
export async function haltNow(deps: HaltDeps): Promise<void> {
  try {
    await deps.dns.setJoinRecord(JOIN_DNS_SINK_IP);
    deps.logger.info('join_dns_sunk', {});
  } catch (err) {
    deps.logger.warn('join_dns_failed', { ip: JOIN_DNS_SINK_IP, error: String(err) });
  }
  await deps.host.shutdownNow();
}
