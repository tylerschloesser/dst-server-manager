// docs/control-plane.md §4, §8: RunInstances params (template name, ClientToken, all four tags on
// both instance and volume), AZ fallback on `InsufficientInstanceCapacity` with a changed token,
// non-capacity error fails fast.
import { describe, expect, it, vi } from 'vitest';

import {
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';
import type { EC2Client } from '@aws-sdk/client-ec2';

import { LAUNCH_TEMPLATE_NAME } from '@dst/shared';

import { createEc2Launcher } from './ec2-launcher';

const SUBNETS = [
  { SubnetId: 'subnet-a', AvailabilityZone: 'us-west-2a' },
  { SubnetId: 'subnet-b', AvailabilityZone: 'us-west-2b' },
];

function makeClient(runInstances: (command: RunInstancesCommand, callIndex: number) => unknown): {
  client: EC2Client;
  send: ReturnType<typeof vi.fn>;
} {
  let runCalls = 0;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeVpcsCommand) return { Vpcs: [{ VpcId: 'vpc-1' }] };
    if (command instanceof DescribeSubnetsCommand) return { Subnets: SUBNETS };
    if (command instanceof RunInstancesCommand) {
      const index = runCalls;
      runCalls += 1;
      const result = runInstances(command, index);
      if (result instanceof Error) throw result;
      return result;
    }
    throw new Error('unexpected command sent to the fake EC2 client');
  });
  return { client: { send } as unknown as EC2Client, send };
}

function capacityError(): Error {
  const err = new Error('Insufficient capacity');
  err.name = 'InsufficientInstanceCapacity';
  return err;
}

describe('createEc2Launcher (docs/control-plane.md §4)', () => {
  it('launches from the launch template, tags instance and volume, ClientToken = sessionId', async () => {
    const { client, send } = makeClient(() => ({ Instances: [{ InstanceId: 'i-123' }] }));
    const launcher = createEc2Launcher(client);

    const result = await launcher.launch({ sessionId: 'sess-1', worldId: 'w1' });
    expect(result).toEqual({ instanceId: 'i-123' });

    const runCall = send.mock.calls.find(([cmd]) => cmd instanceof RunInstancesCommand);
    expect(runCall).toBeDefined();
    const input = (runCall?.[0] as RunInstancesCommand).input;
    expect(input.LaunchTemplate).toEqual({
      LaunchTemplateName: LAUNCH_TEMPLATE_NAME,
      Version: '$Latest',
    });
    expect(input.ClientToken).toBe('sess-1');
    expect(input.MinCount).toBe(1);
    expect(input.MaxCount).toBe(1);

    const instanceTags = input.TagSpecifications?.find((t) => t.ResourceType === 'instance')?.Tags;
    const volumeTags = input.TagSpecifications?.find((t) => t.ResourceType === 'volume')?.Tags;
    for (const tags of [instanceTags, volumeTags]) {
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: 'project', Value: 'dst-server-manager' },
          { Key: 'role', Value: 'game' },
          { Key: 'sessionId', Value: 'sess-1' },
          { Key: 'Name', Value: 'dst-game' },
        ]),
      );
      expect(tags).toHaveLength(4);
    }
  });

  it('retries the next AZ on InsufficientInstanceCapacity, with a changed ClientToken', async () => {
    const { client, send } = makeClient((_cmd, index) =>
      index === 0 ? capacityError() : { Instances: [{ InstanceId: 'i-second-az' }] },
    );
    const launcher = createEc2Launcher(client);

    const result = await launcher.launch({ sessionId: 'sess-2', worldId: 'w1' });
    expect(result).toEqual({ instanceId: 'i-second-az' });

    const runCalls = send.mock.calls.filter(([cmd]) => cmd instanceof RunInstancesCommand);
    expect(runCalls).toHaveLength(2);
    expect((runCalls[0]?.[0] as RunInstancesCommand).input.ClientToken).toBe('sess-2');
    expect((runCalls[1]?.[0] as RunInstancesCommand).input.ClientToken).toBe('sess-2-az1');
  });

  it('fails fast on a non-capacity error, with no retry', async () => {
    const err = new Error('not authorized');
    err.name = 'UnauthorizedOperation';
    const { client, send } = makeClient(() => err);
    const launcher = createEc2Launcher(client);

    await expect(launcher.launch({ sessionId: 'sess-3', worldId: 'w1' })).rejects.toThrow(
      /UnauthorizedOperation/,
    );

    const runCalls = send.mock.calls.filter(([cmd]) => cmd instanceof RunInstancesCommand);
    expect(runCalls).toHaveLength(1);
  });

  it('gives up after min(subnets.length, 4) attempts, all InsufficientInstanceCapacity', async () => {
    const { client, send } = makeClient(() => capacityError());
    const launcher = createEc2Launcher(client);

    await expect(launcher.launch({ sessionId: 'sess-4', worldId: 'w1' })).rejects.toThrow(
      /InsufficientInstanceCapacity/,
    );

    const runCalls = send.mock.calls.filter(([cmd]) => cmd instanceof RunInstancesCommand);
    expect(runCalls).toHaveLength(SUBNETS.length); // min(2 subnets, 4) = 2
  });
});
