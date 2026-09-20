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

export function SignedOutScreen() {
  const [error, setError] = useState<string | null>(null);

  // Read the error param once, then clear it so a refresh drops the message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setError(params.get('error'));
    window.history.replaceState({}, '', '/');
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
