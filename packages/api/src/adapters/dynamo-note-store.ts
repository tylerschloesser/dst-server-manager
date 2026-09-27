// NoteStore adapter (docs/control-plane.md §5.7): item `{ pk: NOTE_PK, sk: worldId, text,
// updatedAt, updatedBy }` in the existing table. The digest Lambda reads this same item (pk
// 'NOTE', sk worldId, attribute `text`), so the shape is a contract. Only GetItem and UpdateItem
// are used: the API role has no DeleteItem, so clearing REMOVEs `text` and keeps the item (with
// who cleared it and when).
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { NOTE_PK, TABLE_NAME } from '@dst/shared';
import type { WorldNote } from '@dst/shared';

import type { NotePutInput, NoteStore } from '../ports';

/** Item -> note; an item without a non-empty `text` (a cleared note) is no note. */
export function parseNoteItem(item: Record<string, unknown> | undefined): WorldNote | null {
  if (item === undefined) return null;
  const text = item['text'];
  if (typeof text !== 'string' || text === '') return null;
  const updatedAt = item['updatedAt'];
  const updatedBy = item['updatedBy'];
  return {
    text,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    updatedBy: typeof updatedBy === 'string' ? updatedBy : null,
  };
}

export function createDynamoNoteStore(client: DynamoDBDocumentClient): NoteStore {
  return {
    async get(worldId: string): Promise<WorldNote | null> {
      const res = await client.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: NOTE_PK, sk: worldId } }),
      );
      return parseNoteItem(res.Item as Record<string, unknown> | undefined);
    },

    async put(a: NotePutInput): Promise<WorldNote> {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: NOTE_PK, sk: a.worldId },
          UpdateExpression: 'SET #text = :text, #updatedAt = :updatedAt, #updatedBy = :updatedBy',
          ExpressionAttributeNames: {
            '#text': 'text',
            '#updatedAt': 'updatedAt',
            '#updatedBy': 'updatedBy',
          },
          ExpressionAttributeValues: {
            ':text': a.text,
            ':updatedAt': a.updatedAt,
            ':updatedBy': a.updatedBy,
          },
        }),
      );
      return { text: a.text, updatedAt: a.updatedAt, updatedBy: a.updatedBy };
    },

    async clear(a: Omit<NotePutInput, 'text'>): Promise<void> {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: NOTE_PK, sk: a.worldId },
          UpdateExpression: 'REMOVE #text SET #updatedAt = :updatedAt, #updatedBy = :updatedBy',
          ExpressionAttributeNames: {
            '#text': 'text',
            '#updatedAt': 'updatedAt',
            '#updatedBy': 'updatedBy',
          },
          ExpressionAttributeValues: { ':updatedAt': a.updatedAt, ':updatedBy': a.updatedBy },
        }),
      );
    },
  };
}
