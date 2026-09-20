// docs/web.md §1: providers, outermost first: MantineProvider -> QueryClientProvider ->
// Notifications -> App. No inline color-scheme bootstrap script (CSP is script-src 'self';
// decisions §16.21) — defaultColorScheme="dark" replaces it, and it is the only scheme in v1.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { App } from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('missing #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <Notifications position="top-center" />
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
