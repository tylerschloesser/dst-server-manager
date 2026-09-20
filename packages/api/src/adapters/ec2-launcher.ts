// Launcher adapter (docs/control-plane.md §4): `RunInstances` from the launch template, one per
// session, with AZ fallback on capacity errors. Subnet discovery is cached for the life of the
// Lambda container (module scope).
import {
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';

import { GAME_REGION, INSTANCE_NAME_TAG, LAUNCH_TEMPLATE_NAME, PROJECT } from '@dst/shared';

import type { LaunchInput, LaunchOutput, Launcher } from '../ports';

interface SubnetInfo {
  subnetId: string;
  availabilityZone: string;
}

/** A small, deterministic string hash (not cryptographic) used only to pick a starting AZ index so
 * repeated retries for the same session spread across AZs deterministically. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function isRetryableCapacityError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'InsufficientInstanceCapacity' || err.name === 'Unsupported';
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.slice(0, 160);
    return `${err.name}: ${message}`;
  }
  return `Error: ${String(err).slice(0, 160)}`;
}

export function createEc2Launcher(
  client: EC2Client = new EC2Client({ region: GAME_REGION }),
): Launcher {
  let cachedSubnets: SubnetInfo[] | null = null;

  async function loadSubnets(): Promise<SubnetInfo[]> {
    if (cachedSubnets !== null) return cachedSubnets;

    const vpcs = await client.send(
      new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }),
    );
    const vpcId = vpcs.Vpcs?.[0]?.VpcId;
    if (vpcId === undefined) {
      throw new Error('no default VPC found in ' + GAME_REGION);
    }

    const subnets = await client.send(
      new DescribeSubnetsCommand({
        Filters: [
          { Name: 'vpc-id', Values: [vpcId] },
          { Name: 'default-for-az', Values: ['true'] },
        ],
      }),
    );

    const infos: SubnetInfo[] = (subnets.Subnets ?? [])
      .filter(
        (s): s is { SubnetId: string; AvailabilityZone: string } =>
          typeof s.SubnetId === 'string' && typeof s.AvailabilityZone === 'string',
      )
      .map((s) => ({ subnetId: s.SubnetId, availabilityZone: s.AvailabilityZone }));

    infos.sort((a, b) => a.availabilityZone.localeCompare(b.availabilityZone));
    if (infos.length === 0) {
      throw new Error('no default-for-az subnets found in the default VPC');
    }

    cachedSubnets = infos;
    return infos;
  }

  return {
    async launch(input: LaunchInput): Promise<LaunchOutput> {
      const subnets = await loadSubnets();
      const startIndex = hashString(input.sessionId) % subnets.length;
      const maxAttempts = Math.min(subnets.length, 4);

      const tags = [
        { Key: 'project', Value: PROJECT },
        { Key: 'role', Value: 'game' },
        { Key: 'sessionId', Value: input.sessionId },
        { Key: 'Name', Value: INSTANCE_NAME_TAG },
      ];

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const subnet = subnets[(startIndex + attempt) % subnets.length];
        if (subnet === undefined) {
          throw new Error('subnet index out of range');
        }
        const clientToken = attempt === 0 ? input.sessionId : `${input.sessionId}-az${attempt}`;

        try {
          const res = await client.send(
            new RunInstancesCommand({
              LaunchTemplate: { LaunchTemplateName: LAUNCH_TEMPLATE_NAME, Version: '$Latest' },
              MinCount: 1,
              MaxCount: 1,
              ClientToken: clientToken,
              SubnetId: subnet.subnetId,
              TagSpecifications: [
                { ResourceType: 'instance', Tags: tags },
                { ResourceType: 'volume', Tags: tags },
              ],
            }),
          );
          const instanceId = res.Instances?.[0]?.InstanceId;
          if (instanceId === undefined) {
            throw new Error('RunInstances returned no instance id');
          }
          return { instanceId };
        } catch (err) {
          const isLastAttempt = attempt === maxAttempts - 1;
          if (isLastAttempt || !isRetryableCapacityError(err)) {
            throw new Error(describeError(err), { cause: err });
          }
          // else: try the next AZ
        }
      }

      // Unreachable: the loop above always returns or throws.
      throw new Error('launch failed: no attempts made');
    },
  };
}
