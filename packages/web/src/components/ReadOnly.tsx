// docs/web.md §3, docs/auth.md §12: a guest link is read-only. Write controls stay visible but
// disabled, each with the same one-line hint. The server refuses every write from a guest anyway
// (403 `read_only`); this only keeps the UI honest about it.
import { createContext, useContext, type ReactNode } from 'react';
import { Box, Tooltip } from '@mantine/core';

export const READ_ONLY_HINT = 'Guest view: read-only';

/** True for a guest link (`MeResponse.guest`), provided once by `App`. */
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/** Wraps a control that is disabled for a guest. A disabled button fires no pointer events, so
 *  the tooltip hangs off a wrapping element instead (Mantine's documented pattern). A no-op for a
 *  member. */
export function ReadOnlyHint({ children }: { children: ReactNode }) {
  const readOnly = useReadOnly();
  if (!readOnly) return <>{children}</>;
  return (
    <Tooltip label={READ_ONLY_HINT} events={{ hover: true, focus: true, touch: true }}>
      <Box>{children}</Box>
    </Tooltip>
  );
}
