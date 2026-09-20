import { describe, expect, it } from 'vitest';

import { buildSessionManifest, resolveStartedBy, trackPeakPlayers } from '../src/core/manifest';

describe('resolveStartedBy', () => {
  it('is the nickname when present', () => {
    expect(resolveStartedBy('Tyler')).toBe('Tyler');
  });

  it('is "unknown" when null', () => {
    expect(resolveStartedBy(null)).toBe('unknown');
  });
});

describe('trackPeakPlayers', () => {
  it('takes the max over readings', () => {
    let peak = 0;
    peak = trackPeakPlayers(peak, 1);
    peak = trackPeakPlayers(peak, 3);
    peak = trackPeakPlayers(peak, 2);
    expect(peak).toBe(3);
  });

  it('peakPlayers ignores UNKNOWN readings', () => {
    let peak = 2;
    peak = trackPeakPlayers(peak, 'unknown');
    expect(peak).toBe(2);
  });
});

describe('buildSessionManifest', () => {
  function input(overrides: Partial<Parameters<typeof buildSessionManifest>[0]> = {}) {
    return {
      sessionId: '20260919T201355Z-a1b2c3',
      worldId: 'test-a',
      startedByNickname: 'Tyler',
      startedAt: '2026-09-19T20:13:55.000Z',
      joinableAt: '2026-09-19T20:16:00.000Z',
      stoppedAt: '2026-09-19T21:00:00.000Z',
      stopReason: 'idle' as const,
      peakPlayers: 2,
      instanceType: 'c6i.large',
      dstBuildId: '12345678',
      preStartVersionId: 'v1',
      postStopVersionId: 'v2',
      ...overrides,
    };
  }

  it('startedBy is a nickname, not a SteamID64', () => {
    const manifest = buildSessionManifest(input({ startedByNickname: 'Tyler' }));
    expect(manifest.startedBy).toBe('Tyler');
  });

  it('startedBy falls back to "unknown" when the nickname is null', () => {
    const manifest = buildSessionManifest(input({ startedByNickname: null }));
    expect(manifest.startedBy).toBe('unknown');
  });

  it('preStartVersionId is null for a generated world', () => {
    const manifest = buildSessionManifest(input({ preStartVersionId: null }));
    expect(manifest.preStartVersionId).toBeNull();
  });

  it('postStopVersionId is null when no save was pushed', () => {
    const manifest = buildSessionManifest(input({ postStopVersionId: null }));
    expect(manifest.postStopVersionId).toBeNull();
  });

  it('carries every other field through verbatim', () => {
    const manifest = buildSessionManifest(input());
    expect(manifest).toMatchObject({
      sessionId: '20260919T201355Z-a1b2c3',
      worldId: 'test-a',
      stopReason: 'idle',
      peakPlayers: 2,
      instanceType: 'c6i.large',
      dstBuildId: '12345678',
    });
  });
});
