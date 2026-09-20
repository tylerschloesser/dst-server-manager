import { describe, expect, it } from 'vitest';
import { statusBadgeProps } from './StatusBadge';

describe('statusBadgeProps', () => {
  it('maps every status to its exact label and color (text is never color-only)', () => {
    expect(statusBadgeProps('stopped')).toEqual({ label: 'Stopped', color: 'gray' });
    expect(statusBadgeProps('starting')).toEqual({ label: 'Starting', color: 'yellow' });
    expect(statusBadgeProps('running')).toEqual({ label: 'Running', color: 'green' });
    expect(statusBadgeProps('stopping')).toEqual({ label: 'Stopping', color: 'orange' });
  });
});
