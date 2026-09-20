// docs/web.md §2, §3: signed-in screen — header, JoinPanel for the active world, one WorldCard
// per world, and the stop/switch confirmation modals (rendered once, at screen level).
import { useState } from 'react';
import { AppShell, Container, Stack } from '@mantine/core';
import type { ActiveInfo, ClusterStatus, WorldSummary } from '@dst/shared';
import { useWorlds } from '../api/queries';
import { useSignOut, useStartWorld, useStopWorld } from '../api/mutations';
import { AppHeader } from '../components/AppHeader';
import { ConfirmStopModal } from '../components/ConfirmStopModal';
import { ConfirmSwitchModal } from '../components/ConfirmSwitchModal';
import { JoinPanel } from '../components/JoinPanel';
import { WorldCard } from '../components/WorldCard';

export interface WorldListScreenProps {
  nickname: string;
}

/** Starting a world while everything is `stopped` needs no confirmation; starting a different
 *  world while one is active asks to switch; the "Stop" button opens the stop confirmation. */
export function decideWorldAction(
  status: ClusterStatus,
  active: ActiveInfo | null,
): 'start' | 'switch' | 'stop' | null {
  if (status === 'stopped') {
    return active && active.status !== 'stopped' ? 'switch' : 'start';
  }
  if (status === 'running') return 'stop';
  return null; // starting / stopping: the button is disabled, nothing to do
}

export function WorldListScreen({ nickname }: WorldListScreenProps) {
  const worldsQuery = useWorlds();
  const startWorld = useStartWorld();
  const stopWorld = useStopWorld();
  const signOut = useSignOut();

  const [stopTarget, setStopTarget] = useState<WorldSummary | null>(null);
  const [switchTarget, setSwitchTarget] = useState<WorldSummary | null>(null);

  const data = worldsQuery.data;
  const worlds = data?.worlds ?? [];
  const active: ActiveInfo | null = data?.active ?? null;
  const activeWorld =
    active !== null ? (worlds.find((w) => w.worldId === active.worldId) ?? null) : null;

  const mutationBusy = startWorld.isPending || stopWorld.isPending;
  const pendingWorldId = startWorld.isPending
    ? startWorld.variables
    : stopWorld.isPending
      ? stopWorld.variables
      : null;

  function handleAction(world: WorldSummary, status: ClusterStatus) {
    const action = decideWorldAction(status, active);
    if (action === 'start') {
      startWorld.mutate(world.worldId);
    } else if (action === 'switch') {
      setSwitchTarget(world);
    } else if (action === 'stop') {
      setStopTarget(world);
    }
  }

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppHeader nickname={nickname} onSignOut={() => signOut.mutate()} />
      <AppShell.Main>
        <Container size="xs">
          <Stack gap="md">
            {active && active.status !== 'stopped' && <JoinPanel active={active} />}
            {worlds.map((world) => (
              <WorldCard
                key={world.worldId}
                world={world}
                active={active}
                disabled={mutationBusy && pendingWorldId !== world.worldId}
                loading={mutationBusy && pendingWorldId === world.worldId}
                onAction={handleAction}
              />
            ))}
          </Stack>
        </Container>
      </AppShell.Main>
      <ConfirmStopModal
        world={stopTarget}
        playerCount={active?.playerCount ?? null}
        onCancel={() => setStopTarget(null)}
        onConfirm={() => {
          if (stopTarget) stopWorld.mutate(stopTarget.worldId);
          setStopTarget(null);
        }}
      />
      <ConfirmSwitchModal
        from={activeWorld}
        to={switchTarget}
        playerCount={active?.playerCount ?? null}
        onCancel={() => setSwitchTarget(null)}
        onConfirm={() => {
          if (switchTarget) startWorld.mutate(switchTarget.worldId);
          setSwitchTarget(null);
        }}
      />
    </AppShell>
  );
}
