// docs/web.md §3 WorldCard: role article, name = displayName.
import { Button, Card, Text, Title } from '@mantine/core';
import type { ActiveInfo, ClusterStatus, WorldSummary } from '@dst/shared';
import { StatusBadge } from './StatusBadge';

/** docs/decisions.md §6 / docs/web.md §3: derived per-world status. */
export function derivedWorldStatus(world: WorldSummary, active: ActiveInfo | null): ClusterStatus {
  return active && active.worldId === world.worldId ? active.status : 'stopped';
}

export function actionButtonLabel(status: ClusterStatus): 'Start' | 'Stop' {
  return status === 'running' || status === 'stopping' ? 'Stop' : 'Start';
}

export function actionButtonColor(status: ClusterStatus): 'green' | 'red' {
  return actionButtonLabel(status) === 'Start' ? 'green' : 'red';
}

export interface WorldCardProps {
  world: WorldSummary;
  active: ActiveInfo | null;
  /** True while a mutation for a *different* card is in flight. */
  disabled: boolean;
  /** True while a mutation for *this* card is in flight. */
  loading: boolean;
  onAction: (world: WorldSummary, status: ClusterStatus) => void;
}

export function WorldCard({ world, active, disabled, loading, onAction }: WorldCardProps) {
  const status = derivedWorldStatus(world, active);
  const busy = status === 'starting' || status === 'stopping';

  return (
    <Card component="article" aria-label={world.displayName} withBorder radius="md" padding="md">
      <Title order={3}>{world.displayName}</Title>
      <StatusBadge status={status} />
      {active !== null && active.worldId === world.worldId && active.stale && (
        <Text size="sm" c="orange">
          Not responding — check back in a minute.
        </Text>
      )}
      <Button
        fullWidth
        size="md"
        mt="sm"
        color={actionButtonColor(status)}
        disabled={disabled || busy}
        loading={loading || busy}
        onClick={() => onAction(world, status)}
      >
        {actionButtonLabel(status)}
      </Button>
    </Card>
  );
}
