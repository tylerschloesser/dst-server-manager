// docs/web.md §3 Recap: the world's "next time" notes, newest first, above the latest recap.
// Each note has a ⋯ menu (Edit swaps the row for the editor, Delete asks inline); "Add note" opens
// the same editor at the top. Only one editor or confirm is open at a time. Every write is a
// bodyless POST (the text rides in the `x-dst-note` header) answered with the whole list.
import { useState } from 'react';
import { ActionIcon, Box, Button, Group, Menu, Paper, Stack, Text, Textarea } from '@mantine/core';
import { IconDots, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { NOTE_MAX_CHARS } from '@dst/shared/recap';
import type { WorldNote } from '@dst/shared';
import { ApiError } from '../api/client';
import { useAddNote, useDeleteNote, useEditNote } from '../api/recaps';
import { ReadOnlyHint, useReadOnly } from './ReadOnly';

/** `Tyler · Oct 3`, `Tyler · Oct 3 · edited`, `Tyler · Oct 3 · edited by Ni`. */
export function noteMeta(note: WorldNote, locale?: string): string {
  const parts: string[] = [note.createdBy ?? 'Someone'];
  const created = new Date(note.createdAt);
  if (note.createdAt !== '' && !Number.isNaN(created.getTime())) {
    parts.push(created.toLocaleDateString(locale, { month: 'short', day: 'numeric' }));
  }
  if (note.editedBy !== null) parts.push(`edited by ${note.editedBy}`);
  else if (note.editedAt !== null) parts.push('edited');
  return parts.join(' · ');
}

interface NoteEditorProps {
  initial: string;
  pending: boolean;
  onCancel: () => void;
  onSave: (text: string) => void;
}

function NoteEditor({ initial, pending, onCancel, onSave }: NoteEditorProps) {
  const [draft, setDraft] = useState(initial);
  return (
    <Stack gap="xs">
      <Textarea
        label="Note for next time"
        description="Everyone sees it here before the next session."
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
          <Button variant="default" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={pending}
            disabled={draft.trim() === ''}
            onClick={() => onSave(draft)}
          >
            Save note
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

type Editing = 'new' | string | null;

export interface NotesBoxProps {
  worldId: string;
  notes: WorldNote[];
}

export function NotesBox({ worldId, notes }: NotesBoxProps) {
  const add = useAddNote(worldId);
  const edit = useEditNote(worldId);
  const remove = useDeleteNote(worldId);
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  function open(next: Editing) {
    setConfirming(null);
    setEditing(next);
  }

  function ask(id: string) {
    setEditing(null);
    setConfirming(id);
  }

  const newEditor = (
    <NoteEditor
      initial=""
      pending={add.isPending}
      onCancel={() => setEditing(null)}
      onSave={(text) => add.mutate(text, { onSuccess: () => setEditing(null) })}
    />
  );

  if (notes.length === 0) {
    if (editing === 'new') return newEditor;
    return (
      <ReadOnlyHint>
        <Button variant="light" size="sm" fullWidth disabled={readOnly} onClick={() => open('new')}>
          Add a note for next time
        </Button>
      </ReadOnlyHint>
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
          Next time
        </Text>
        <ReadOnlyHint>
          <Button
            variant="subtle"
            size="compact-sm"
            leftSection={<IconPlus size={14} />}
            disabled={readOnly || editing === 'new'}
            onClick={() => open('new')}
          >
            Add note
          </Button>
        </ReadOnlyHint>
      </Group>
      {editing === 'new' && newEditor}
      <Paper withBorder radius="md">
        {notes.map((note, i) => (
          <Box
            key={note.id}
            data-testid="world-note"
            p="sm"
            style={i > 0 ? { borderTop: '1px solid var(--mantine-color-default-border)' } : {}}
          >
            {editing === note.id ? (
              <NoteEditor
                initial={note.text}
                pending={edit.isPending}
                onCancel={() => setEditing(null)}
                onSave={(text) =>
                  edit.mutate(
                    { id: note.id, text },
                    {
                      onSuccess: () => setEditing(null),
                      // Deleted under us: the list refetches, so the editor has nothing to edit.
                      onError: (err) => {
                        if (err instanceof ApiError && err.code === 'note_not_found') {
                          setEditing(null);
                        }
                      },
                    },
                  )
                }
              />
            ) : confirming === note.id ? (
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm">Delete this note?</Text>
                <Group gap="xs" wrap="nowrap">
                  <Button variant="default" size="sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                  <Button
                    color="red"
                    size="sm"
                    loading={remove.isPending}
                    onClick={() => remove.mutate(note.id, { onSuccess: () => setConfirming(null) })}
                  >
                    Delete
                  </Button>
                </Group>
              </Group>
            ) : (
              <NoteRow
                note={note}
                readOnly={readOnly}
                onEdit={() => open(note.id)}
                onDelete={() => ask(note.id)}
              />
            )}
          </Box>
        ))}
      </Paper>
    </Stack>
  );
}

interface NoteRowProps {
  note: WorldNote;
  readOnly: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function NoteRow({ note, readOnly, onEdit, onDelete }: NoteRowProps) {
  return (
    <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Text data-testid="world-note-text" fw={500} style={{ overflowWrap: 'anywhere' }}>
          {note.text}
        </Text>
        <Text size="xs" c="dimmed">
          {noteMeta(note)}
        </Text>
      </Stack>
      <ReadOnlyHint>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label="Note actions" disabled={readOnly}>
              <IconDots size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconPencil size={14} />} onClick={onEdit}>
              Edit
            </Menu.Item>
            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={onDelete}>
              Delete
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </ReadOnlyHint>
    </Group>
  );
}
