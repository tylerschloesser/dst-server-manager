// @dst/supervisor adapters: the DynamoDB table (docs/control-plane.md §2). Every
// `UpdateExpression`/`ConditionExpression` is built by the shared `state-expressions.ts`
// builders — this module imports them and defines none of its own (docs/game-server.md §8).
// `StatePort.write` covers only S4/S5/S6 (the writes `core/reduce.ts` emits as commands); S1
// (claim), S2 (joinable), S3 (heartbeat) and S7 (error note) are not reduce outputs — they are
// called directly by the loop in `src/index.ts` — so this adapter exposes them as extra methods
// alongside the `StatePort`/`RegistryPort` interfaces it implements.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  parseClusterState,
  parseWorldItem,
  s1Claim,
  s2Joinable,
  s3Heartbeat,
  s4StopBegins,
  s5Switch,
  s6FinalStopped,
  s7ErrorNote,
  s8ReleaseDesire,
} from '@dst/shared';
import type { ClusterStateItem, WorldRegistryItem } from '@dst/shared';

import type { RegistryPort, StatePort, WriteCommand } from '../core';

export interface S1ClaimArgs {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly publicIp: string;
  readonly now: Date;
}

export interface S2JoinableArgs {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly worldId: string;
  readonly idleDeadline: string;
  readonly now: Date;
}

export interface S3HeartbeatArgs {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly playerCount: number | null;
  readonly idleDeadline: string | null;
  readonly now: Date;
}

export interface S7ErrorNoteArgs {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly error: string;
  readonly now: Date;
}

export interface DdbAdapter extends StatePort, RegistryPort {
  claim(args: S1ClaimArgs): Promise<boolean>;
  joinable(args: S2JoinableArgs): Promise<boolean>;
  heartbeat(args: S3HeartbeatArgs): Promise<boolean>;
  errorNote(args: S7ErrorNoteArgs): Promise<boolean>;
}

async function tryUpdate(
  client: DynamoDBDocumentClient,
  input: UpdateCommandInput,
): Promise<boolean> {
  try {
    await client.send(new UpdateCommand(input));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

function toUpdateInput(command: WriteCommand, now: Date): UpdateCommandInput {
  switch (command.kind) {
    case 'S4':
      return s4StopBegins({
        sessionId: command.sessionId,
        instanceId: command.instanceId,
        reason: command.reason,
        now,
      });
    case 'S5':
      return s5Switch({
        instanceId: command.instanceId,
        oldSessionId: command.sessionId,
        newSessionId: command.newSessionId,
        newWorldId: command.newWorldId,
        desiredBy: command.desiredBy,
        desiredByNickname: command.desiredByNickname,
        now,
      });
    case 'S6':
      return s6FinalStopped({
        sessionId: command.sessionId,
        instanceId: command.instanceId,
        reason: command.reason,
      });
    case 'S8':
      return s8ReleaseDesire({
        sessionId: command.sessionId,
        instanceId: command.instanceId,
        worldId: command.worldId,
        now,
      });
  }
}

export function createDdbAdapter(
  client: DynamoDBDocumentClient,
  tableName: string,
  now: () => Date,
): DdbAdapter {
  return {
    async getState(): Promise<ClusterStateItem> {
      const res = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: 'STATE', sk: 'CLUSTER' },
          ConsistentRead: true,
        }),
      );
      return parseClusterState(res.Item);
    },

    async getWorld(worldId: string): Promise<WorldRegistryItem | null> {
      const res = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: 'WORLD', sk: worldId } }),
      );
      if (res.Item === undefined) return null;
      return parseWorldItem(res.Item);
    },

    async write(command: WriteCommand): Promise<boolean> {
      return tryUpdate(client, toUpdateInput(command, now()));
    },

    async claim(args: S1ClaimArgs): Promise<boolean> {
      return tryUpdate(client, s1Claim(args));
    },

    async joinable(args: S2JoinableArgs): Promise<boolean> {
      return tryUpdate(client, s2Joinable(args));
    },

    async heartbeat(args: S3HeartbeatArgs): Promise<boolean> {
      return tryUpdate(client, s3Heartbeat(args));
    },

    async errorNote(args: S7ErrorNoteArgs): Promise<boolean> {
      return tryUpdate(client, s7ErrorNote(args));
    },
  };
}
