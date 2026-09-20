// docs/web.md §3 WorldCard: exact text Stopped / Starting / Running / Stopping, colors
// gray / yellow / green / orange. Status is always readable as text, never color alone.
import { Badge } from '@mantine/core';
import type { ClusterStatus } from '@dst/shared';

export function statusBadgeProps(status: ClusterStatus): { label: string; color: string } {
  switch (status) {
    case 'stopped':
      return { label: 'Stopped', color: 'gray' };
    case 'starting':
      return { label: 'Starting', color: 'yellow' };
    case 'running':
      return { label: 'Running', color: 'green' };
    case 'stopping':
      return { label: 'Stopping', color: 'orange' };
  }
}

export interface StatusBadgeProps {
  status: ClusterStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const { label, color } = statusBadgeProps(status);
  return <Badge color={color}>{label}</Badge>;
}
