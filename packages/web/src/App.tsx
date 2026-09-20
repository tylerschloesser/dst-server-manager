// docs/web.md §2: screen switch — loading | signed-out | world list. No router (two screens).
import { AppShell, Container, Skeleton, Stack } from '@mantine/core';
import { useMe } from './api/queries';
import { SignedOutScreen } from './screens/SignedOutScreen';
import { WorldListScreen } from './screens/WorldListScreen';

function LoadingScreen() {
  return (
    <AppShell padding="md">
      <AppShell.Main>
        <Container size="xs">
          <Stack gap="md">
            <Skeleton height={96} radius="md" />
            <Skeleton height={96} radius="md" />
            <Skeleton height={96} radius="md" />
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}

export function App() {
  const me = useMe();

  if (me.isPending) {
    return <LoadingScreen />;
  }
  if (me.data == null) {
    return <SignedOutScreen />;
  }
  return <WorldListScreen nickname={me.data.nickname} />;
}
