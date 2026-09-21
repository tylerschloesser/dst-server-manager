// Route 53 adapter for the reaper's DNS backstop (docs/decisions.md §17, docs/infra.md §4.4).
// One record, one action: `UPSERT play.dst.ty.ler.dev A <ip>` in the existing shared zone. The
// reaper role's IAM statement is scoped to that exact name and type, so this adapter physically
// cannot touch `dst.ty.ler.dev` or anything else the zone serves.
//
// `UPSERT` rather than `DELETE`: it is idempotent and needs no knowledge of the record's current
// value, which the reaper — looking at an instance that is already gone — does not have. Route 53
// is global; the client lives in `CONTROL_REGION` like the rest of this Lambda.
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { CONTROL_REGION, HOSTED_ZONE_ID, JOIN_DNS_TTL, JOIN_HOSTNAME } from '@dst/shared';

import type { ReaperDns } from '../reaper';

export function createRoute53Dns(
  client: Route53Client = new Route53Client({ region: CONTROL_REGION }),
): ReaperDns {
  return {
    async setJoinRecord(ip: string): Promise<void> {
      await client.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: HOSTED_ZONE_ID,
          ChangeBatch: {
            Comment: 'dst-server-manager join record (reaper)',
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
