// docs/web.md §3 JoinPanel: role region, name "How to join".
import { Box, Button, Group, List, Loader, Paper, Text, Title } from '@mantine/core';
// The value import is from the `@dst/shared/constants` subpath, never the barrel: the barrel
// reaches `ids.ts`, which imports `node:crypto`, and Vite externalizes that for the browser — the
// whole SPA then fails to boot on `randomBytes`. Types are erased, so `import type` from the
// barrel is fine (decisions §16.2 still holds: one definition, in @dst/shared).
import { STEAM_LAUNCH_URL } from '@dst/shared/constants';
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

/** docs/web.md §3: `steam://run/322330` hands the viewer's browser to Steam, which launches DST
 *  and nothing more — Steam ignores arguments passed through `steam://run/<appid>//<args>` and
 *  `steam://connect` is Source-only, so there is no auto-connect to be had (docs/decisions.md
 *  §17). Rendered while `starting` too: the client takes minutes to load, so launching it early
 *  is the useful thing to do. A plain link, never a fetch — CSP governs no top-level navigation
 *  to an external protocol handler. */
function LaunchButton({ mt, mb }: { mt?: string; mb?: string }) {
  return (
    <Button component="a" href={STEAM_LAUNCH_URL} mt={mt} mb={mb} size="md">
      Launch Don&apos;t Starve Together
    </Button>
  );
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
        <Box>
          <Group mt="md" wrap="nowrap">
            <Loader size="sm" />
            <Text>Starting the server. Usually about 3 minutes.</Text>
          </Group>
          <LaunchButton mt="md" />
        </Box>
      )}
      {active.status === 'running' && active.join && (
        <Box mt="md">
          <LaunchButton mb="md" />
          <CopyRow label="Server name" value={active.join.serverName} copyLabel="server name" />
          <CopyRow
            label="Address"
            value={`${active.join.host}:${active.join.port}`}
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
            Or press the backtick key in game and paste the console command. It is the same every
            session, so it is worth saving. If it does not connect yet, tonight&apos;s address is{' '}
            {active.join.ip}:{active.join.port}.
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
