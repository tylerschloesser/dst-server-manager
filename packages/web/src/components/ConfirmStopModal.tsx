// docs/web.md §3 Modals: role dialog, name = title.
import { Alert, Button, Group, Modal, Text } from '@mantine/core';
import type { WorldSummary } from '@dst/shared';

export interface ConfirmStopModalProps {
  world: WorldSummary | null;
  playerCount: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmStopModal({
  world,
  playerCount,
  onCancel,
  onConfirm,
}: ConfirmStopModalProps) {
  return (
    <Modal
      opened={world != null}
      onClose={onCancel}
      title={world ? `Stop ${world.displayName}?` : ''}
      centered
    >
      {world && (
        <>
          <Text>The world is saved before it stops.</Text>
          {playerCount !== null && playerCount > 0 && (
            <Alert color="yellow" mt="sm">
              {playerCount} player{playerCount === 1 ? '' : 's'} still online — they'll be
              disconnected.
            </Alert>
          )}
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
            <Button color="red" onClick={onConfirm}>
              Stop world
            </Button>
          </Group>
        </>
      )}
    </Modal>
  );
}
