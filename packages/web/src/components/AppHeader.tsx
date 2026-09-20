// docs/web.md §2, §3: header shows the app title, the nickname, and a "Sign out" button.
import { AppShell, Button, Group, Text, Title } from '@mantine/core';

export interface AppHeaderProps {
  nickname: string;
  onSignOut: () => void;
}

export function AppHeader({ nickname, onSignOut }: AppHeaderProps) {
  return (
    <AppShell.Header>
      <Group justify="space-between" h="100%" px="md">
        <Title order={1} size="h4">
          DST Server
        </Title>
        <Group gap="sm">
          <Text size="sm">{nickname}</Text>
          <Button variant="subtle" size="compact-sm" onClick={onSignOut}>
            Sign out
          </Button>
        </Group>
      </Group>
    </AppShell.Header>
  );
}
