// docs/web.md §3 Recap: "Last session" under each world card. Read on a phone right before playing,
// so it is ordered by usefulness and skimmable: the "next time" note, the LLM summary, then the
// deterministic facts; carried items and container contents fold away; older sessions sit in an
// accordion. Rendered outside the card's `article` so the card's own queries stay unambiguous.
// The map is its own section right after this one (`MapSection.tsx`).
import type { ReactNode } from 'react';
import { Accordion, Divider, Paper, Skeleton, Stack, Text, Title } from '@mantine/core';
import type { ClusterStatus, RecapEntry, RecapPlayerView, WorldSummary } from '@dst/shared';
import { useRecaps } from '../api/recaps';
import {
  containerGroupText,
  countedName,
  dailyBiomesText,
  deathText,
  deltaText,
  itemText,
  newTilesText,
  playerLabel,
  recapDetails,
  recapHeadline,
  sessionDateText,
  topChanges,
} from '../lib/recap-format';
import { NotesBox } from './Notes';
import { SummaryMarkdown } from './SummaryMarkdown';

const WRAP = { overflowWrap: 'anywhere' } as const;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Text size="sm" style={WRAP}>
      <Text span fw={700}>
        {label}
      </Text>{' '}
      {children}
    </Text>
  );
}

function PlayerName({ p, i }: { p: RecapPlayerView; i: number }) {
  return (
    <Text span fw={600}>
      {playerLabel(p, i)}
    </Text>
  );
}

function Carrying({ players }: { players: RecapPlayerView[] }) {
  return (
    <Stack gap="xs">
      {players.map((p, i) => {
        const c = p.carrying;
        return (
          <Stack key={p.ref} gap={2}>
            <Text size="sm" fw={700}>
              {playerLabel(p, i)}
              {p.characterName !== null ? ` (${p.characterName})` : ''}
            </Text>
            {c === null ? (
              <Text size="sm" c="dimmed">
                Nothing recorded.
              </Text>
            ) : (
              <>
                {c.equipped.length > 0 && (
                  <Fact label="Equipped">{c.equipped.map((e) => itemText(e.item)).join(', ')}</Fact>
                )}
                <Fact label="Inventory">
                  {c.inventory.length > 0 ? c.inventory.map(itemText).join(', ') : 'empty'}
                </Fact>
                {c.backpack !== null && (
                  <Fact label={c.backpack.name}>
                    {c.backpack.items.length > 0
                      ? c.backpack.items.map(itemText).join(', ')
                      : 'empty'}
                  </Fact>
                )}
              </>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

export function RecapBody({ entry }: { entry: RecapEntry }) {
  const { recap, summary } = entry;
  const details = recapDetails(recap);
  const storage = topChanges(recap.storage);
  const learned = recap.players.filter((p) => p.learned.length > 0);
  const travelled = recap.players
    .map((p, i) => ({ p, i, tiles: newTilesText(p), days: dailyBiomesText(p.dailyPositions) }))
    .filter((t) => t.tiles !== null || t.days !== null);
  const carriers = recap.players.filter((p) => p.carrying !== null);

  return (
    <Stack gap="sm">
      {summary.status === 'ok' ? (
        <SummaryMarkdown text={summary.text} />
      ) : (
        <Text size="sm" c="dimmed">
          Summary unavailable
        </Text>
      )}

      <Divider />

      <div>
        <Text fw={700} style={WRAP}>
          {recapHeadline(recap)}
        </Text>
        {details.length > 0 && (
          <Text size="sm" c="dimmed" style={WRAP}>
            {details.join(' · ')}
          </Text>
        )}
      </div>

      {recap.continuous === false && (
        <Text size="sm" c="yellow">
          The world was restored before this session, so changes compare against the restored save.
        </Text>
      )}
      {recap.status === 'partial' && (
        <Text size="sm" c="yellow">
          Partial recap: the save after this session is missing, so only what the logs show is here.
        </Text>
      )}

      {recap.built.length > 0 && (
        <Fact label="Built">{recap.built.map(countedName).join(', ')}</Fact>
      )}
      {recap.destroyed.length > 0 && (
        <Fact label="Destroyed">{recap.destroyed.map(countedName).join(', ')}</Fact>
      )}
      {learned.length > 0 && (
        <Fact label="Learned">
          {learned
            .map(
              (p) =>
                `${playerLabel(p, recap.players.indexOf(p))}: ${p.learned.map((l) => l.name).join(', ')}`,
            )
            .join(' · ')}
        </Fact>
      )}
      {recap.deaths.length > 0 && (
        <Fact label={recap.deaths.length === 1 ? 'Death' : 'Deaths'}>
          {recap.deaths.map((d) => deathText(d, recap.players)).join(' · ')}
        </Fact>
      )}
      {storage.shown.length > 0 && (
        <Fact label="Storage">
          {storage.shown.map((s) => `${deltaText(s.delta)} ${s.name}`).join(', ')}
          {storage.more > 0 ? `, and ${storage.more} more` : ''}
        </Fact>
      )}

      {travelled.length > 0 && (
        <Stack gap={2}>
          <Text size="sm" fw={700}>
            Where you went
          </Text>
          {travelled.map(({ p, i, tiles, days }) => (
            <Text key={p.ref} size="sm" style={WRAP}>
              <PlayerName p={p} i={i} />
              {tiles !== null ? `: ${tiles}` : ''}
              {days !== null ? (
                <>
                  <br />
                  <Text span size="sm" c="dimmed">
                    {days}
                  </Text>
                </>
              ) : null}
            </Text>
          ))}
        </Stack>
      )}

      {(carriers.length > 0 || recap.containers.length > 0) && (
        <Accordion variant="contained" radius="md" multiple>
          {carriers.length > 0 && (
            <Accordion.Item value="carrying">
              <Accordion.Control>You are carrying</Accordion.Control>
              <Accordion.Panel>
                <Carrying players={recap.players} />
              </Accordion.Panel>
            </Accordion.Item>
          )}
          {recap.containers.length > 0 && (
            <Accordion.Item value="containers">
              <Accordion.Control>Where our stuff is</Accordion.Control>
              <Accordion.Panel>
                <Stack gap={4}>
                  {recap.containers.map((g) => (
                    <Text key={`${g.shard}:${g.prefab}`} size="sm" style={WRAP}>
                      {containerGroupText(g)}
                    </Text>
                  ))}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          )}
        </Accordion>
      )}

      {recap.notes.length > 0 && (
        <Text size="xs" c="dimmed" style={WRAP}>
          {recap.notes.join(' · ')}
        </Text>
      )}
    </Stack>
  );
}

export interface RecapSectionProps {
  world: WorldSummary;
  status: ClusterStatus;
}

export function RecapSection({ world, status }: RecapSectionProps) {
  const query = useRecaps(world.worldId, status);
  const data = query.data;
  const [latest, ...older] = data?.recaps ?? [];
  const latestDate = latest ? sessionDateText(latest.recap) : null;

  return (
    <Paper
      component="section"
      aria-label={`${world.displayName} recap`}
      withBorder
      radius="md"
      p={{ base: 'sm', sm: 'md' }}
    >
      <Stack gap="sm">
        <Title order={4}>
          Last session
          {latestDate !== null && (
            <Text span size="sm" c="dimmed" fw={400}>
              {' '}
              · {latestDate}
            </Text>
          )}
        </Title>

        {query.isPending && <Skeleton height={72} radius="sm" />}
        {query.isError && (
          <Text size="sm" c="dimmed">
            Couldn&apos;t load the recap. It will retry.
          </Text>
        )}

        {data && (
          <>
            <NotesBox
              worldId={world.worldId}
              notes={data.notes}
              since={latest?.recap.session.startedAt ?? null}
            />
            {latest ? (
              <RecapBody entry={latest} />
            ) : (
              <Text size="sm" c="dimmed">
                No recap yet. One appears here a minute or two after a session ends.
              </Text>
            )}
            {older.length > 0 && (
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Earlier sessions
              </Text>
            )}
            {older.length > 0 && (
              <Accordion variant="contained" radius="md">
                {older.map((entry) => {
                  const date = sessionDateText(entry.recap);
                  return (
                    <Accordion.Item key={entry.sessionId} value={entry.sessionId}>
                      <Accordion.Control>
                        <Text size="sm" fw={600} style={WRAP}>
                          {date !== null ? `${date} · ` : ''}
                          {recapHeadline(entry.recap)}
                        </Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <RecapBody entry={entry} />
                      </Accordion.Panel>
                    </Accordion.Item>
                  );
                })}
              </Accordion>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}
