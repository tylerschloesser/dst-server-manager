// Lambda entry for the reaper (docs/control-plane.md §6, §16.39): wires the real adapters and
// calls `runReaper`. Nothing here holds reaper logic.
import {
  DescribeInstancesCommand,
  EC2Client,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';

import { GAME_REGION, PROJECT } from '@dst/shared';

import { createDynamoDocumentClient, createDynamoStateStore } from '../adapters/dynamo-state-store';
import { createRoute53Dns } from '../adapters/route53-dns';
import { systemClock } from '../adapters/system-clock';
import type { ReaperEc2, ReaperEvent, ReaperInstance } from '../reaper';
import { runReaper } from '../reaper';

const ec2Client = new EC2Client({ region: GAME_REGION });

const ec2: ReaperEc2 = {
  async describeGameInstances(): Promise<ReaperInstance[]> {
    const instances: ReaperInstance[] = [];
    let nextToken: string | undefined;
    do {
      const res = await ec2Client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'tag:project', Values: [PROJECT] },
            { Name: 'tag:role', Values: ['game'] },
            { Name: 'instance-state-name', Values: ['pending', 'running'] },
          ],
          NextToken: nextToken,
        }),
      );
      for (const reservation of res.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (instance.InstanceId === undefined || instance.LaunchTime === undefined) continue;
          const sessionIdTag = instance.Tags?.find((t) => t.Key === 'sessionId')?.Value ?? null;
          instances.push({
            instanceId: instance.InstanceId,
            launchTime: instance.LaunchTime,
            sessionIdTag,
          });
        }
      }
      nextToken = res.NextToken;
    } while (nextToken !== undefined);
    return instances;
  },

  async terminate(instanceId: string): Promise<void> {
    try {
      await ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (err) {
      if (err instanceof Error && err.name === 'InvalidInstanceID.NotFound') return;
      throw err;
    }
  },
};

const documentClient = createDynamoDocumentClient();
const store = createDynamoStateStore(documentClient);
const dns = createRoute53Dns();

export const handler = async (event: ReaperEvent) =>
  runReaper(event, { store, ec2, dns, clock: systemClock });
