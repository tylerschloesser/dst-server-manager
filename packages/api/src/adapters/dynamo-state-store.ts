// StateStore adapter (docs/control-plane.md §2, §5.1): the one DynamoDB item `pk="STATE",
// sk="CLUSTER"`. Every write goes through the pure builders in `@dst/shared/state-expressions` so
// the API, the reaper and the supervisor share one definition of every write.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import {
  CONTROL_REGION,
  TABLE_NAME,
  parseClusterState,
  w1StartFresh,
  w2SetDesired,
  w3ClearDesired,
  w4RollbackLaunch,
} from '@dst/shared';
import type { ClusterStateItem } from '@dst/shared';

import type { StateStore } from '../ports';

const KEY = { pk: 'STATE', sk: 'CLUSTER' } as const;

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

export function createDynamoDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: CONTROL_REGION }), {
    marshallOptions: { removeUndefinedValues: false },
  });
}

export function createDynamoStateStore(client: DynamoDBDocumentClient): StateStore {
  async function tryUpdate(input: UpdateCommandInput): Promise<boolean> {
    try {
      await client.send(new UpdateCommand(input));
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  return {
    async get(): Promise<ClusterStateItem> {
      const res = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: KEY, ConsistentRead: true }),
      );
      return parseClusterState(res.Item as Record<string, unknown> | undefined);
    },
    startFresh(a) {
      return tryUpdate(w1StartFresh(a));
    },
    setDesired(a) {
      return tryUpdate(w2SetDesired(a));
    },
    clearDesired(a) {
      return tryUpdate(w3ClearDesired(a));
    },
    rollbackLaunch(a) {
      return tryUpdate(w4RollbackLaunch({ sessionId: a.sessionId, error: a.error }));
    },
  };
}
