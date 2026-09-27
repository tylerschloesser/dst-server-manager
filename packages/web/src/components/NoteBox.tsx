// docs/web.md §3 Recap: the one-line "next time" note, shown at the top of the recap, editable in
// place. Saved with a bodyless POST (the text rides in the `x-dst-note` header).
import { useState } from 'react';
import { Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { NOTE_MAX_CHARS } from '@dst/shared/recap';
import type { WorldNote } from '@dst/shared';
import { useSaveNote } from '../api/recaps';

export interface NoteBoxProps {
  worldId: string;
  note: WorldNote | null;
}

export function NoteBox({ worldId, note }: NoteBoxProps) {
  const save = useSaveNote(worldId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function startEditing() {
    setDraft(note?.text ?? '');
    setEditing(true);
  }

  function submit() {
    save.mutate(draft, { onSuccess: () => setEditing(false) });
  }

  if (editing) {
    return (
      <Stack gap="xs">
        <Textarea
          label="Note for next time"
          description="Everyone sees it here before the next session. Leave empty to clear."
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          maxLength={NOTE_MAX_CHARS}
          autosize
          minRows={2}
          maxRows={4}
          autoFocus
          size="md"
        />
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {draft.length}/{NOTE_MAX_CHARS}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={save.isPending} onClick={submit}>
              Save note
            </Button>
          </Group>
        </Group>
      </Stack>
    );
  }

  if (note === null) {
    return (
      <Button variant="light" size="sm" fullWidth onClick={startEditing}>
        Add a note for next time
      </Button>
    );
  }

  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        Next time
      </Text>
      <Text data-testid="world-note" fw={500} style={{ overflowWrap: 'anywhere' }}>
        {note.text}
      </Text>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="xs" c="dimmed" style={{ minWidth: 0 }} truncate>
          {note.updatedBy !== null ? `by ${note.updatedBy}` : ''}
        </Text>
        <Button variant="subtle" size="compact-sm" onClick={startEditing}>
          Edit note
        </Button>
      </Group>
    </Stack>
  );
}
