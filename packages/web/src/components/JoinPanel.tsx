// docs/web.md §3 JoinPanel: role region, name "How to join".
import { Box, Group, List, Loader, Paper, Text, Title } from '@mantine/core';
import type { ActiveInfo } from '@dst/shared';
import { useCountdown, type CountdownState } from '../hooks/useCountdown';
import { playerCountLabel } from '../lib/format';
import { CopyRow } from './CopyRow';

/** docs/web.md §3 JoinPanel countdown text. */
export function idleCountdownText(
  playerCount: number | null,
  idleDeadline: string | null,
  countdown: CountdownState,
): string | null {
  if (playerCount !== null && playerCount > 0) {
    return 'Auto-stops once everyone has left.';
  }
  if (!idleDeadline) return null;
  if (countdown.expired) return 'Stopping soon…';
  return `Stops in ${countdown.label} if nobody is playing`;
}

export interface JoinPanelProps {
  active: ActiveInfo;
}

export function JoinPanel({ active }: JoinPanelProps) {
  const countdown = useCountdown(active.idleDeadline);
  const countdownText = idleCountdownText(active.playerCount, active.idleDeadline, countdown);

  return (
    <Paper component="section" aria-labelledby="join-heading" withBorder p="md">
      <Title order={2} size="h4" id="join-heading">
        How to join
      </Title>
      {active.status === 'starting' && (
        <Group mt="md" wrap="nowrap">
          <Loader size="sm" />
          <Text>Starting the server. Usually about 3 minutes.</Text>
        </Group>
      )}
      {active.status === 'running' && active.join && (
        <Box mt="md">
          <CopyRow label="Server name" value={active.join.serverName} copyLabel="server name" />
          <CopyRow
            label="Address"
            value={`${active.join.ip}:${active.join.port}`}
            copyLabel="server address"
          />
          <CopyRow label="Password" value={active.join.password} copyLabel="password" />
          <CopyRow
            label="Console command"
            value={active.join.connectCommand}
            copyLabel="console command"
            code
          />
          <List type="ordered" size="sm" mt="sm">
            <List.Item>Open Don't Starve Together and click Browse Games.</List.Item>
            <List.Item>Search for the server name above.</List.Item>
            <List.Item>Click Join and enter the password.</List.Item>
          </List>
          <Text size="sm" c="dimmed" mt="xs">
            Or press the backtick key in game and paste the console command.
          </Text>
          <Text data-testid="player-count" mt="sm">
            {playerCountLabel(active.playerCount)}
          </Text>
          <Text size="sm" c="dimmed">
            Started by {active.startedBy}
          </Text>
        </Box>
      )}
      {countdownText && (
        <Text size="sm" data-testid="idle-countdown" mt="xs">
          {countdownText}
        </Text>
      )}
    </Paper>
  );
}
