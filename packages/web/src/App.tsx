// docs/web.md §2: screen switch — loading | signed-out | world list. No router (two screens). A
// guest link gets the world list, read-only.
import { AppShell, Container, Skeleton, Stack } from '@mantine/core';
import { useMe } from './api/queries';
import { ReadOnlyContext } from './components/ReadOnly';
import { SignedOutScreen } from './screens/SignedOutScreen';
import { WorldListScreen } from './screens/WorldListScreen';

function LoadingScreen() {
  return (
    <AppShell padding={{ base: 'xs', sm: 'md' }}>
      <AppShell.Main>
        <Container size="xs" px={0}>
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
  // A guest link (docs/auth.md §12) sees everything read-only; `=== true` so a cached `me` from
  // before the field existed reads as a member, as it was.
  return (
    <ReadOnlyContext.Provider value={me.data.guest === true}>
      <WorldListScreen nickname={me.data.nickname} />
    </ReadOnlyContext.Provider>
  );
}
