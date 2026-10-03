// NoteStore adapter (docs/control-plane.md §5.7): one item per world, `{ pk: NOTE_PK, sk: worldId,
// notes: { <id>: { text, createdAt, createdBy, editedAt?, editedBy? } } }`, in the existing table.
// The digest Lambda reads this same item through the same `parseNotesItem`, so the shape is a
// contract. Only GetItem and UpdateItem are used (the API role has no DeleteItem): a delete is
// `REMOVE notes.<id>`. Each write touches one map key, so writes to different notes never clobber
// each other and two writes to one note resolve as last write wins.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import {
  LEGACY_NOTE_ID,
  NOTE_PK,
  NOTES_MAX,
  TABLE_NAME,
  applyNoteEdit,
  legacyNote,
  parseNotesItem,
} from '@dst/shared';
import type { StoredNote, WorldNote } from '@dst/shared';

import { ApiError } from '../errors';
import type { NoteStore } from '../ports';

type Item = Record<string, unknown>;

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

function notesMap(item: Item | undefined): Item | null {
  const map = item?.['notes'];
  return map !== null && typeof map === 'object' && !Array.isArray(map) ? (map as Item) : null;
}

export function createDynamoNoteStore(client: DynamoDBDocumentClient): NoteStore {
  const key = (worldId: string) => ({ pk: NOTE_PK, sk: worldId });

  async function getItem(worldId: string): Promise<Item | undefined> {
    const res = await client.send(new GetCommand({ TableName: TABLE_NAME, Key: key(worldId) }));
    return res.Item as Item | undefined;
  }

  /** The item's `notes` map, migrating a legacy single-note item (or creating the item) first:
   *  `SET notes = :seed REMOVE text, updatedAt, updatedBy` where `:seed` holds the legacy note or
   *  is empty. Losing that race to another writer just means re-reading. */
  async function ensureNotesMap(worldId: string): Promise<Item> {
    const item = await getItem(worldId);
    const existing = notesMap(item);
    if (existing !== null) return existing;
    const legacy = item === undefined ? null : legacyNote(item);
    const seed: Record<string, StoredNote> = legacy === null ? {} : { [LEGACY_NOTE_ID]: legacy };
    try {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: key(worldId),
          UpdateExpression: 'SET #notes = :seed REMOVE #text, #updatedAt, #updatedBy',
          ConditionExpression: 'attribute_not_exists(#notes)',
          ExpressionAttributeNames: {
            '#notes': 'notes',
            '#text': 'text',
            '#updatedAt': 'updatedAt',
            '#updatedBy': 'updatedBy',
          },
          ExpressionAttributeValues: { ':seed': seed },
        }),
      );
      return seed;
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      return notesMap(await getItem(worldId)) ?? {};
    }
  }

  /** One UpdateItem on one map key, returning the whole list as it now stands. */
  async function updateOne(
    worldId: string,
    id: string,
    expr: { update: string; condition?: string; values?: Record<string, unknown> },
  ): Promise<WorldNote[]> {
    const res = await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key(worldId),
        UpdateExpression: expr.update,
        ...(expr.condition !== undefined ? { ConditionExpression: expr.condition } : {}),
        ExpressionAttributeNames: { '#notes': 'notes', '#id': id },
        ...(expr.values !== undefined ? { ExpressionAttributeValues: expr.values } : {}),
        ReturnValues: 'ALL_NEW',
      }),
    );
    return parseNotesItem(res.Attributes as Item | undefined);
  }

  return {
    async list(worldId) {
      return parseNotesItem(await getItem(worldId));
    },

    async add(worldId, id, note) {
      await ensureNotesMap(worldId);
      try {
        return await updateOne(worldId, id, {
          update: 'SET #notes.#id = :note',
          condition: 'size(#notes) < :max',
          values: { ':note': note, ':max': NOTES_MAX },
        });
      } catch (err) {
        if (isConditionalCheckFailed(err)) throw new ApiError('too_many_notes');
        throw err;
      }
    },

    async edit(worldId, id, text, editor, now) {
      const current = (await ensureNotesMap(worldId))[id];
      if (current === null || typeof current !== 'object') return null;
      try {
        return await updateOne(worldId, id, {
          update: 'SET #notes.#id = :note',
          condition: 'attribute_exists(#notes.#id)',
          values: { ':note': applyNoteEdit(current as StoredNote, text, editor, now) },
        });
      } catch (err) {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      }
    },

    async remove(worldId, id) {
      await ensureNotesMap(worldId);
      return updateOne(worldId, id, { update: 'REMOVE #notes.#id' });
    },
  };
}
