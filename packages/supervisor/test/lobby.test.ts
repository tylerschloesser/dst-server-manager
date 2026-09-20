import { describe, expect, it } from 'vitest';

import {
  LOBBY_RECOVERY_THRESHOLD,
  LOBBY_REPORT_THRESHOLD,
  LOBBY_SCRATCH_ENTRIES,
  MAX_LOBBY_RECOVERIES,
  lobbyScratchPaths,
  shouldRecoverLobbyRegistration,
  shouldReportLobbyFailure,
} from '../src/core/lobby';
import type { LobbyRegistrationState } from '../src/core/lobby';
import { parseMasterBroadcastError } from '../src/core/parse';

// The three lines the Master logs per failed broadcast, captured verbatim from a real instance in
// T5.2 (docs/_first-boot-notes.md round 2). Only the middle one is a countable error.
const CURL_LINE =
  '[00:01:54]: [Http] Curl failed[1] with HTTP_500, retrying (2 times). Response: _{"Error":{"Code":"E_ROWID_EXIST"}}_';
const ERROR_LINE = '[00:01:55]: [Error] Master Server Broadcast Error: E_ROWID_EXIST';
const RETRY_LINE = '[00:00:41]: Master Server Broadcast will try to broadcast a new listing.';

function state(over: Partial<LobbyRegistrationState> = {}): LobbyRegistrationState {
  return {
    registered: false,
    broadcastErrorCount: 0,
    recoveriesDone: 0,
    reported: false,
    ...over,
  };
}

describe('parseMasterBroadcastError', () => {
  it('returns the Klei error code of a failed lobby broadcast', () => {
    expect(parseMasterBroadcastError(ERROR_LINE)).toBe('E_ROWID_EXIST');
  });

  it('counts one error per failure: neither the Curl line nor the retry line matches', () => {
    expect(parseMasterBroadcastError(CURL_LINE)).toBeNull();
    expect(parseMasterBroadcastError(RETRY_LINE)).toBeNull();
  });

  it('returns null for an unrelated line', () => {
    expect(
      parseMasterBroadcastError('[00:00:49]: Server registered via geo DNS in us-east-1'),
    ).toBeNull();
  });
});

describe('lobbyScratchPaths', () => {
  it('removes exactly the three per-session scratch entries, per shard', () => {
    expect(lobbyScratchPaths('/opt/dst/klei/DoNotStarveTogether/w', ['Master', 'Caves'])).toEqual([
      '/opt/dst/klei/DoNotStarveTogether/w/Master/save/server_temp',
      '/opt/dst/klei/DoNotStarveTogether/w/Master/save/client_temp',
      '/opt/dst/klei/DoNotStarveTogether/w/Master/save/cached_userid',
      '/opt/dst/klei/DoNotStarveTogether/w/Caves/save/server_temp',
      '/opt/dst/klei/DoNotStarveTogether/w/Caves/save/client_temp',
      '/opt/dst/klei/DoNotStarveTogether/w/Caves/save/cached_userid',
    ]);
  });

  it('touches only per-session scratch under a shard save/ directory, never the world', () => {
    for (const entry of LOBBY_SCRATCH_ENTRIES) expect(entry.startsWith('save/')).toBe(true);
    for (const p of lobbyScratchPaths('/cluster', ['Master'])) {
      expect(p.startsWith('/cluster/Master/save/')).toBe(true);
      expect(p).not.toContain('session');
    }
  });

  it('has no Caves entry for a single-shard world', () => {
    expect(lobbyScratchPaths('/cluster', ['Master'])).toHaveLength(LOBBY_SCRATCH_ENTRIES.length);
  });
});

describe('shouldReportLobbyFailure', () => {
  it('reports once the broadcast has failed a few times in a row', () => {
    expect(shouldReportLobbyFailure(state({ broadcastErrorCount: LOBBY_REPORT_THRESHOLD }))).toBe(
      true,
    );
  });

  it('stays quiet about a single transient failure', () => {
    expect(
      shouldReportLobbyFailure(state({ broadcastErrorCount: LOBBY_REPORT_THRESHOLD - 1 })),
    ).toBe(false);
  });

  it('says it once, not on every poll', () => {
    expect(shouldReportLobbyFailure(state({ broadcastErrorCount: 99, reported: true }))).toBe(
      false,
    );
  });

  it('never reports once the Master has registered', () => {
    expect(shouldReportLobbyFailure(state({ broadcastErrorCount: 99, registered: true }))).toBe(
      false,
    );
  });
});

describe('shouldRecoverLobbyRegistration', () => {
  it('waits far longer than the report threshold before restarting anything', () => {
    // Measured in T5.2: on an in-place switch the refusal is the previous session's lobby row,
    // which no local action can release — restarting early costs ~90 s for nothing.
    expect(LOBBY_RECOVERY_THRESHOLD).toBeGreaterThan(LOBBY_REPORT_THRESHOLD * 4);
    expect(
      shouldRecoverLobbyRegistration(state({ broadcastErrorCount: LOBBY_RECOVERY_THRESHOLD - 1 })),
    ).toBe(false);
  });

  it('fires once the broadcast has failed for minutes on end', () => {
    expect(
      shouldRecoverLobbyRegistration(state({ broadcastErrorCount: LOBBY_RECOVERY_THRESHOLD })),
    ).toBe(true);
  });

  it('never fires once the Master has registered (a later refresh failure is not a stuck boot)', () => {
    expect(
      shouldRecoverLobbyRegistration(state({ broadcastErrorCount: 999, registered: true })),
    ).toBe(false);
  });

  it('stops after the per-session recovery budget, leaving the boot timeout to decide', () => {
    expect(
      shouldRecoverLobbyRegistration(
        state({ broadcastErrorCount: 999, recoveriesDone: MAX_LOBBY_RECOVERIES }),
      ),
    ).toBe(false);
  });
});
