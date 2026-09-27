// docs/control-plane.md §5.7: the note item shape is a contract with the digest Lambda
// (pk 'NOTE', sk worldId, attribute `text`), and the API role has no DeleteItem.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';

import { NOTE_PK, TABLE_NAME } from '@dst/shared';

import { createDynamoNoteStore, parseNoteItem } from './dynamo-note-store';

function fakeClient(response: unknown = {}) {
  const sent: unknown[] = [];
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      return response;
    }),
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

describe('createDynamoNoteStore', () => {
  it('get reads { pk: NOTE, sk: worldId }', async () => {
    const { client, sent } = fakeClient({
      Item: { pk: NOTE_PK, sk: 'w', text: 'hi', updatedAt: 't', updatedBy: 'Dev' },
    });
    const note = await createDynamoNoteStore(client).get('w');
    expect(note).toEqual({ text: 'hi', updatedAt: 't', updatedBy: 'Dev' });
    expect(sent[0]).toBeInstanceOf(GetCommand);
    expect((sent[0] as GetCommand).input).toEqual({
      TableName: TABLE_NAME,
      Key: { pk: 'NOTE', sk: 'w' },
    });
  });

  it('put is an UpdateItem that SETs text, updatedAt, updatedBy', async () => {
    const { client, sent } = fakeClient();
    const out = await createDynamoNoteStore(client).put({
      worldId: 'w',
      text: 'bring ice',
      updatedAt: 't',
      updatedBy: 'Dev',
    });
    expect(out).toEqual({ text: 'bring ice', updatedAt: 't', updatedBy: 'Dev' });
    expect(sent[0]).toBeInstanceOf(UpdateCommand);
    const input = (sent[0] as UpdateCommand).input;
    expect(input.Key).toEqual({ pk: 'NOTE', sk: 'w' });
    expect(input.UpdateExpression).toBe(
      'SET #text = :text, #updatedAt = :updatedAt, #updatedBy = :updatedBy',
    );
    expect(input.ExpressionAttributeNames?.['#text']).toBe('text');
    expect(input.ExpressionAttributeValues?.[':text']).toBe('bring ice');
  });

  it('clear is an UpdateItem that REMOVEs text (never a DeleteItem)', async () => {
    const { client, sent } = fakeClient();
    await createDynamoNoteStore(client).clear({ worldId: 'w', updatedAt: 't', updatedBy: 'Dev' });
    expect(sent[0]).toBeInstanceOf(UpdateCommand);
    const input = (sent[0] as UpdateCommand).input;
    expect(input.Key).toEqual({ pk: 'NOTE', sk: 'w' });
    expect(input.UpdateExpression).toMatch(/^REMOVE #text SET /);
  });
});

describe('parseNoteItem', () => {
  it('treats an absent item or a cleared (text-less / empty) item as no note', () => {
    expect(parseNoteItem(undefined)).toBeNull();
    expect(parseNoteItem({ pk: 'NOTE', sk: 'w', updatedAt: 't' })).toBeNull();
    expect(parseNoteItem({ pk: 'NOTE', sk: 'w', text: '' })).toBeNull();
  });

  it('defaults a missing updatedBy to null', () => {
    expect(parseNoteItem({ text: 'x', updatedAt: 't' })).toEqual({
      text: 'x',
      updatedAt: 't',
      updatedBy: null,
    });
  });
});
