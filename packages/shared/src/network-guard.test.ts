// docs/testing.md §1bis: proves the repo-root vitest.setup.ts guard is actually wired into this
// package's Vitest config, rather than trusted on faith. Names are exact — the orchestrator greps
// for them character for character.
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';

describe('vitest network/AWS guard', () => {
  it('blocks real network access in unit tests', () => {
    // The stub (`vi.fn(() => blocked())`) throws synchronously, exactly like a real `fetch` call
    // that fails before returning a Promise (e.g. an invalid URL) can; assert the sync throw
    // rather than treating the call as already a rejected Promise.
    expect(() => fetch('https://example.com')).toThrow('network access is blocked in unit tests');
  });

  it('blocks real AWS SDK calls in unit tests', async () => {
    const client = new DynamoDBClient({ region: 'us-east-1' });
    await expect(
      client.send(new DescribeTableCommand({ TableName: 'dst-server-manager' })),
    ).rejects.toThrow('network access is blocked in unit tests');
  });
});
