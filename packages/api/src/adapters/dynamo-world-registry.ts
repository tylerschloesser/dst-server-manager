// WorldRegistry adapter (docs/control-plane.md §5.1, §1.3): `pk="WORLD"` items, queried and
// validated per item. An invalid item is logged and omitted rather than failing the whole
// response (docs/control-plane.md §1.3).
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { InvalidItemError, TABLE_NAME, parseWorldItem } from '@dst/shared';
import type { WorldRegistryItem } from '@dst/shared';

import type { WorldRegistry } from '../ports';

export function createDynamoWorldRegistry(client: DynamoDBDocumentClient): WorldRegistry {
  return {
    async list(): Promise<WorldRegistryItem[]> {
      const res = await client.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': 'WORLD' },
        }),
      );
      const items = res.Items ?? [];
      const worlds: WorldRegistryItem[] = [];
      for (const raw of items) {
        try {
          worlds.push(parseWorldItem(raw as Record<string, unknown>));
        } catch (err) {
          if (err instanceof InvalidItemError) {
            console.log(JSON.stringify({ event: 'world_item_invalid', worldId: raw?.['worldId'] }));
            continue;
          }
          throw err;
        }
      }
      worlds.sort((a, b) => a.displayName.localeCompare(b.displayName));
      return worlds;
    },

    async get(worldId: string): Promise<WorldRegistryItem | null> {
      const res = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: 'WORLD', sk: worldId } }),
      );
      if (res.Item === undefined) return null;
      return parseWorldItem(res.Item as Record<string, unknown>);
    },
  };
}
