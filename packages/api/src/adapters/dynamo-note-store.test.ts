// docs/control-plane.md §5.7: the notes item shape is a contract with the digest Lambda (pk 'NOTE',
// sk worldId, a `notes` map), the API role has no DeleteItem, and a legacy single-note item is
// migrated by the first write.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';

import { NOTES_MAX, TABLE_NAME } from '@dst/shared';

import { ApiError } from '../errors';
import { createDynamoNoteStore } from './dynamo-note-store';

const ID = '11111111-2222-4333-8444-555555555555';

/** Answers each command with the next scripted response (an Error is thrown). */
function fakeClient(...responses: unknown[]) {
  const sent: unknown[] = [];
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      const r = responses.shift() ?? {};
      if (r instanceof Error) throw r;
      return r;
    }),
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

const ccf = () => Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
const input = (c: unknown) => (c as UpdateCommand).input;
const migrated = { Item: { pk: 'NOTE', sk: 'w', notes: {} } };

describe('createDynamoNoteStore', () => {
  it('list is one GetItem on { pk: NOTE, sk: worldId }, newest first', async () => {
    const { client, sent } = fakeClient({
      Item: {
        notes: {
          a: { text: 'old', createdAt: '1', createdBy: 'Ni' },
          b: { text: 'new', createdAt: '2', createdBy: 'Dev' },
        },
      },
    });
    const notes = await createDynamoNoteStore(client).list('w');
    expect(notes.map((n) => n.text)).toEqual(['new', 'old']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetCommand);
    expect((sent[0] as GetCommand).input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'NOTE', sk: 'w' },
    });
  });

  it('list folds a legacy item without writing', async () => {
    const { client, sent } = fakeClient({ Item: { text: 'hi', updatedAt: 't', updatedBy: 'Ni' } });
    expect(await createDynamoNoteStore(client).list('w')).toMatchObject([
      { id: 'legacy', text: 'hi', createdBy: 'Ni' },
    ]);
    expect(sent).toHaveLength(1);
  });

  it('the first write migrates a legacy item: SET notes = seed REMOVE text, guarded', async () => {
    const { client, sent } = fakeClient(
      { Item: { pk: 'NOTE', sk: 'w', text: 'hi', updatedAt: 't', updatedBy: 'Ni' } },
      {},
      { Attributes: { notes: {} } },
    );
    await createDynamoNoteStore(client).remove('w', 'legacy');
    const m = input(sent[1]);
    expect(m.UpdateExpression).toBe('SET #notes = :seed REMOVE #text, #updatedAt, #updatedBy');
    expect(m.ConditionExpression).toBe('attribute_not_exists(#notes)');
    expect(m.ExpressionAttributeValues?.[':seed']).toEqual({
      legacy: { text: 'hi', createdAt: 't', createdBy: 'Ni' },
    });
    expect(input(sent[2]).UpdateExpression).toBe('REMOVE #notes.#id');
    expect(input(sent[2]).ExpressionAttributeNames?.['#id']).toBe('legacy');
  });

  it('the first write to a world with no item seeds an empty map', async () => {
    const { client, sent } = fakeClient({}, {}, { Attributes: { notes: {} } });
    await createDynamoNoteStore(client).add('w', ID, { text: 'x', createdAt: 't', createdBy: 'D' });
    expect(input(sent[1]).ExpressionAttributeValues?.[':seed']).toEqual({});
  });

  it('losing the migration race re-reads instead of failing', async () => {
    const { client, sent } = fakeClient(
      { Item: { text: 'hi' } },
      ccf(),
      { Item: { notes: { [ID]: { text: 'theirs', createdAt: 't', createdBy: 'Ni' } } } },
      { Attributes: { notes: {} } },
    );
    const out = await createDynamoNoteStore(client).edit('w', ID, 'mine', 'Dev', 't2');
    expect(out).toEqual([]);
    expect(sent[2]).toBeInstanceOf(GetCommand);
    expect(input(sent[3]).ExpressionAttributeValues?.[':note']).toEqual({
      text: 'mine',
      createdAt: 't',
      createdBy: 'Ni',
      editedAt: 't2',
      editedBy: 'Dev',
    });
  });

  it('add SETs one map key, guarded by the cap, and returns ALL_NEW parsed', async () => {
    const note = { text: 'bring ice', createdAt: 't', createdBy: 'Dev' };
    const { client, sent } = fakeClient(migrated, { Attributes: { notes: { [ID]: note } } });
    const out = await createDynamoNoteStore(client).add('w', ID, note);
    expect(out).toEqual([{ id: ID, ...note, editedAt: null, editedBy: null }]);
    expect(sent).toHaveLength(2); // already migrated: no seed write
    const a = input(sent[1]);
    expect(a.Key).toEqual({ pk: 'NOTE', sk: 'w' });
    expect(a.UpdateExpression).toBe('SET #notes.#id = :note');
    expect(a.ConditionExpression).toBe('size(#notes) < :max');
    expect(a.ExpressionAttributeNames).toEqual({ '#notes': 'notes', '#id': ID });
    expect(a.ExpressionAttributeValues).toEqual({ ':note': note, ':max': NOTES_MAX });
    expect(a.ReturnValues).toBe('ALL_NEW');
  });

  it('add past the cap is too_many_notes', async () => {
    const { client } = fakeClient(migrated, ccf());
    const err = await createDynamoNoteStore(client)
      .add('w', ID, { text: 'x', createdAt: 't', createdBy: 'D' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('too_many_notes');
  });

  it('edit SETs the edited note guarded by attribute_exists; a self-edit omits editedBy', async () => {
    const { client, sent } = fakeClient(
      { Item: { notes: { [ID]: { text: 'a', createdAt: 't', createdBy: 'Dev' } } } },
      { Attributes: { notes: {} } },
    );
    expect(await createDynamoNoteStore(client).edit('w', ID, 'b', 'Dev', 't2')).toEqual([]);
    const e = input(sent[1]);
    expect(e.ConditionExpression).toBe('attribute_exists(#notes.#id)');
    expect(e.ExpressionAttributeValues?.[':note']).toEqual({
      text: 'b',
      createdAt: 't',
      createdBy: 'Dev',
      editedAt: 't2',
    });
  });

  it('edit of a missing note, or one deleted under it, is null', async () => {
    const missing = fakeClient(migrated);
    expect(await createDynamoNoteStore(missing.client).edit('w', ID, 'b', 'D', 't')).toBeNull();
    expect(missing.sent).toHaveLength(1);

    const raced = fakeClient(
      { Item: { notes: { [ID]: { text: 'a', createdAt: 't', createdBy: 'Dev' } } } },
      ccf(),
    );
    expect(await createDynamoNoteStore(raced.client).edit('w', ID, 'b', 'D', 't')).toBeNull();
  });

  it('remove is an UpdateItem REMOVE (never a DeleteItem) with no condition', async () => {
    const { client, sent } = fakeClient(migrated, { Attributes: { notes: {} } });
    expect(await createDynamoNoteStore(client).remove('w', ID)).toEqual([]);
    const r = input(sent[1]);
    expect(sent[1]).toBeInstanceOf(UpdateCommand);
    expect(r.UpdateExpression).toBe('REMOVE #notes.#id');
    expect(r.ConditionExpression).toBeUndefined();
  });
});
