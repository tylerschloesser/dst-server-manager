// docs/web.md §3 Signed out screen.
import { useEffect, useState } from 'react';
import { Alert, Button, Center, Container, Stack, Text, Title } from '@mantine/core';

export function signedOutErrorMessage(error: string | null): string | null {
  if (!error) return null;
  if (error === 'not-allowed') {
    return "That Steam account isn't on the allowlist. Ask the server owner to add you.";
  }
  return "Sign-in didn't work. Please try again.";
}

// Reads the `error` query param synchronously. Exported so a unit test can exercise exactly
// what the lazy `useState` initializer below captures, without a DOM or React.
export function readErrorParam(search: string): string | null {
  return new URLSearchParams(search).get('error');
}

// Strips the query string down to `/` so a refresh drops the message. Reads nothing from the
// URL itself, so calling it more than once (StrictMode double-invokes effects in development) is
// a harmless no-op the second time.
export function clearErrorFromUrl(): void {
  window.history.replaceState({}, '', '/');
}

export function SignedOutScreen() {
  // Lazy initializer: runs synchronously during the first render, before React commits and
  // before any effect fires — including a StrictMode-induced second effect invocation, which
  // happens only after this has already captured the value. This is what makes mount
  // idempotent: the error is captured once, up front, instead of being re-derived from a URL
  // the effect below has since stripped.
  const [error] = useState(() => readErrorParam(window.location.search));

  // Only clears the URL; never reads it, so running this twice changes nothing.
  useEffect(() => {
    clearErrorFromUrl();
  }, []);

  const message = signedOutErrorMessage(error);

  return (
    <Container size="xs">
      <Center style={{ minHeight: '100vh' }}>
        <Stack gap="md" style={{ width: '100%' }}>
          <Title order={1}>DST Server</Title>
          <Text c="dimmed">Sign in to start a world.</Text>
          {message && (
            <Alert color="red" title="Can't sign in">
              {message}
            </Alert>
          )}
          <Button component="a" href="/api/auth/steam/login" size="lg" fullWidth>
            Sign in with Steam
          </Button>
        </Stack>
      </Center>
    </Container>
  );
}
