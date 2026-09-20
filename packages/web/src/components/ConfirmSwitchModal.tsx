// docs/web.md §3 Modals: role dialog, name = title.
import { Alert, Button, Group, Modal, Text } from '@mantine/core';
import type { WorldSummary } from '@dst/shared';

export interface ConfirmSwitchModalProps {
  from: WorldSummary | null;
  to: WorldSummary | null;
  playerCount: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmSwitchModal({
  from,
  to,
  playerCount,
  onCancel,
  onConfirm,
}: ConfirmSwitchModalProps) {
  const details = from && to ? { from, to } : null;

  return (
    <Modal
      opened={details != null}
      onClose={onCancel}
      title={details ? `Switch to ${details.to.displayName}?` : ''}
      centered
    >
      {details && (
        <>
          <Text>
            {details.from.displayName} will be saved and stopped first, then{' '}
            {details.to.displayName} starts on the same server. This takes a few minutes.
          </Text>
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
              Save and switch
            </Button>
          </Group>
        </>
      )}
    </Modal>
  );
}
