import { describe, expect, it } from 'vitest';

import {
  buildCountQueryLine,
  isCavesLinked,
  isLoadComplete,
  isRegistered,
  isShuttingDown,
  parseBuildId,
  parseCountReply,
  parsePauseEdge,
  parseShardDisconnected,
} from '../src/core/parse';

describe('buildCountQueryLine', () => {
  it('substitutes the nonce into the DSTQ marker', () => {
    const line = buildCountQueryLine(42);
    expect(line).toContain('DSTQ 42 ');
    expect(line).toContain('shard_players:GetNumPlayers()');
    expect(line).toContain('#GetPlayerClientTable()');
    expect(line).toContain('#AllPlayers');
  });
});

describe('parseCountReply', () => {
  it('does not match the RemoteCommandInput: echo of the command', () => {
    const echoed = `[00:00:00]: RemoteCommandInput: ${buildCountQueryLine(7)}`;
    expect(parseCountReply(echoed, 7)).toBeNull();
  });

  it('matches the answer line', () => {
    expect(parseCountReply('DSTQ 7 true 0 2 3', 7)).toEqual({
      kind: 'ok',
      shardplayers: 0,
      clients: 2,
      allplayers: 3,
    });
  });

  it('tolerates a trailing TAB after the last field', () => {
    expect(parseCountReply('DSTQ 7 true 0 2 3\t', 7)).toEqual({
      kind: 'ok',
      shardplayers: 0,
      clients: 2,
      allplayers: 3,
    });
  });

  it('ignores a reply carrying the wrong nonce', () => {
    expect(parseCountReply('DSTQ 8 true 0 2 3', 7)).toBeNull();
  });

  it('is unknown when ok=false', () => {
    expect(parseCountReply('DSTQ 7 false nil nil nil', 7)).toEqual({ kind: 'unknown' });
  });

  it('is unknown when a field is nil', () => {
    expect(parseCountReply('DSTQ 7 true nil 2 3', 7)).toEqual({ kind: 'unknown' });
  });

  it('returns null for an unrelated line', () => {
    expect(parseCountReply('[00:00:00]: Some other log line', 7)).toBeNull();
  });
});

describe('joinable clauses', () => {
  it('matches "Server registered via geo DNS"', () => {
    expect(isRegistered('[00:00:12]: Server registered via geo DNS in us-west-2')).toBe(true);
    expect(isRegistered('[00:00:12]: something else')).toBe(false);
  });

  it('matches "World N(Caves) is now connected" anchored on the shard name', () => {
    expect(isCavesLinked('[00:00:12]: World 40987672(Caves) is now connected')).toBe(true);
    expect(isCavesLinked('[00:00:12]: World 2 is now connected')).toBe(false);
  });

  it('parses the anchored Sim paused / Sim unpaused edge, not Server Autopaused', () => {
    expect(parsePauseEdge('[00:00:12]: Sim paused')).toBe(true);
    expect(parsePauseEdge('[00:00:12]: Sim unpaused')).toBe(false);
    expect(parsePauseEdge('[00:00:12]: Server Autopaused')).toBeNull();
  });

  it('matches "LOAD BE: done"', () => {
    expect(isLoadComplete('[00:00:12]:      LOAD BE: done')).toBe(true);
    expect(isLoadComplete('[00:00:12]: LOAD BE: not done yet')).toBe(false);
  });

  it('matches the shard-disconnect line and returns the shard name', () => {
    expect(parseShardDisconnected("[00:00:12]: [Shard] A shard has disconnected: 'Caves(2)'")).toBe(
      'Caves',
    );
    expect(parseShardDisconnected('[00:00:12]: nothing to see here')).toBeNull();
  });

  it('matches "Shutting down"', () => {
    expect(isShuttingDown('[00:00:12]: Shutting down')).toBe(true);
    expect(isShuttingDown('[00:00:12]: still running')).toBe(false);
  });
});

describe('parseBuildId', () => {
  it('reads the buildid out of a sample appmanifest_343050.acf', () => {
    const acf = `"AppState"
{
	"appid"		"343050"
	"universe"		"1"
	"name"		"Don't Starve Together Dedicated Server"
	"buildid"		"12345678"
}
`;
    expect(parseBuildId(acf)).toBe('12345678');
  });

  it('returns null when there is no buildid field', () => {
    expect(parseBuildId('"AppState"\n{\n}\n')).toBeNull();
  });
});
