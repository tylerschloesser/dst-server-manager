// The one change batch this project ever sends to Route 53 (docs/infra.md §4.4). It has to be
// byte-right: the IAM statement on the instance role narrows
// `route53:ChangeResourceRecordSetsNormalizedRecordNames` to exactly this name and
// `...RecordTypes` to `A`, so a wrong name, a trailing dot or a second change in the batch is an
// `AccessDenied` at runtime, not a deploy-time error. No network — `vitest.setup.ts` blocks it;
// the client is a capture stub.
import type { Route53Client } from '@aws-sdk/client-route-53';
import { HOSTED_ZONE_ID, JOIN_DNS_SINK_IP, JOIN_DNS_TTL, JOIN_HOSTNAME } from '@dst/shared';
import { describe, expect, it } from 'vitest';

import { createRoute53Adapter } from './route53';

function captureClient(): { client: Route53Client; inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  const client = {
    send: (command: { input: Record<string, unknown> }) => {
      inputs.push(command.input);
      return Promise.resolve({});
    },
  } as unknown as Route53Client;
  return { client, inputs };
}

describe('createRoute53Adapter', () => {
  it('UPSERTs exactly one A record for the join hostname', async () => {
    const { client, inputs } = captureClient();
    await createRoute53Adapter(client).setJoinRecord('203.0.113.10');

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      HostedZoneId: HOSTED_ZONE_ID,
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: JOIN_HOSTNAME,
              Type: 'A',
              TTL: JOIN_DNS_TTL,
              ResourceRecords: [{ Value: '203.0.113.10' }],
            },
          },
        ],
      },
    });
  });

  it('writes the name in its normalized form: lowercase, no trailing dot', () => {
    expect(JOIN_HOSTNAME).toBe(JOIN_HOSTNAME.toLowerCase());
    expect(JOIN_HOSTNAME.endsWith('.')).toBe(false);
  });

  it('sinks to the parked TEST-NET-1 address through the same UPSERT', async () => {
    const { client, inputs } = captureClient();
    await createRoute53Adapter(client).setJoinRecord(JOIN_DNS_SINK_IP);

    const changes = (inputs[0] as { ChangeBatch: { Changes: unknown[] } }).ChangeBatch.Changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      Action: 'UPSERT',
      ResourceRecordSet: { ResourceRecords: [{ Value: '192.0.2.1' }] },
    });
  });
});
