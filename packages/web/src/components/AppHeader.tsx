// docs/web.md §2, §3: header shows the app title, the nickname (or a "Guest · read-only" badge),
// and a "Sign out" button, which a guest keeps: it only clears the cookie.
import { AppShell, Badge, Button, Group, Text, Title } from '@mantine/core';
import { useReadOnly } from './ReadOnly';

export interface AppHeaderProps {
  nickname: string;
  onSignOut: () => void;
}

export function AppHeader({ nickname, onSignOut }: AppHeaderProps) {
  const readOnly = useReadOnly();
  return (
    <AppShell.Header>
      <Group justify="space-between" h="100%" px={{ base: 'xs', sm: 'md' }}>
        <Title order={1} size="h4">
          DST Server
        </Title>
        <Group gap="sm">
          {readOnly ? (
            <Badge variant="light" color="gray" size="lg" tt="none">
              Guest · read-only
            </Badge>
          ) : (
            <Text size="sm">{nickname}</Text>
          )}
          <Button variant="subtle" size="compact-sm" onClick={onSignOut}>
            Sign out
          </Button>
        </Group>
      </Group>
    </AppShell.Header>
  );
}
