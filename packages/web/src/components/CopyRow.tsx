// docs/web.md §3 JoinPanel, §5: a Group wrap="nowrap" with the value in a Box that can shrink,
// and an ActionIcon (size xl, so it clears 44px) whose accessible name flips with copy state.
import { ActionIcon, Box, Code, CopyButton, Group, Text } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

export interface CopyRowProps {
  label: string;
  value: string;
  copyLabel: string;
  /** Render the value as a wrapped `<Code block>` (used for the console command). */
  code?: boolean;
}

export function CopyRow({ label, value, copyLabel, code }: CopyRowProps) {
  return (
    <Group wrap="nowrap" justify="space-between" gap="sm">
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" c="dimmed">
          {label}
        </Text>
        {code ? (
          <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {value}
          </Code>
        ) : (
          <Text style={{ wordBreak: 'break-all' }}>{value}</Text>
        )}
      </Box>
      <CopyButton value={value} timeout={2000}>
        {({ copied, copy }) => (
          <ActionIcon
            size="xl"
            variant="subtle"
            color={copied ? 'teal' : 'gray'}
            onClick={copy}
            aria-label={`${copied ? 'Copied' : 'Copy'} ${copyLabel}`}
          >
            {copied ? <IconCheck size={20} /> : <IconCopy size={20} />}
          </ActionIcon>
        )}
      </CopyButton>
    </Group>
  );
}
