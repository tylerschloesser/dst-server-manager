// @dst/supervisor adapters: the one runtime DNS record (docs/decisions.md §17, docs/infra.md
// §4.4). `JOIN_HOSTNAME` is an A record in the existing shared zone, written here at boot and
// sunk to `JOIN_DNS_SINK_IP` on every halt — never a CDK resource, so the stacks keep owning
// exactly two `AWS::Route53::RecordSet`s.
//
// `UPSERT`, always: it is idempotent and needs no knowledge of the record's current value, unlike
// a Route 53 `DELETE`, which must match the existing RRSet exactly. Route 53 is global, so the
// client is built in `CONTROL_REGION` even though this process runs in `GAME_REGION`.
//
// Every caller treats a failure here as non-fatal (`join_dns_failed`): the raw IP is still shown
// in the UI, and DNS must never be able to block a boot or — far worse — a stop.
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { HOSTED_ZONE_ID, JOIN_DNS_TTL, JOIN_HOSTNAME } from '@dst/shared';

import type { DnsPort } from '../core';

export function createRoute53Adapter(client: Route53Client): DnsPort {
  return {
    async setJoinRecord(ip: string): Promise<void> {
      await client.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: HOSTED_ZONE_ID,
          ChangeBatch: {
            Comment: 'dst-server-manager join record',
            Changes: [
              {
                Action: 'UPSERT',
                ResourceRecordSet: {
                  Name: JOIN_HOSTNAME,
                  Type: 'A',
                  TTL: JOIN_DNS_TTL,
                  ResourceRecords: [{ Value: ip }],
                },
              },
            ],
          },
        }),
      );
    },
  };
}

/** In-memory `DnsPort` for the unit tests: records every value written, newest last, and can be
 *  made to throw so the "a failed Route 53 call is never fatal" paths are exercised for real. */
export class FakeDns implements DnsPort {
  readonly writes: string[] = [];
  private failure: Error | null = null;

  failWith(err: Error): void {
    this.failure = err;
  }

  async setJoinRecord(ip: string): Promise<void> {
    this.writes.push(ip);
    if (this.failure !== null) throw this.failure;
  }
}
