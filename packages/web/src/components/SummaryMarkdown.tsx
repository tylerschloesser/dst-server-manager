// Renders `parseMarkdown`'s blocks as React elements: text only, never HTML
// (no dangerouslySetInnerHTML), so a summary can never inject markup or script.
import { Fragment } from 'react';
import { List, Stack, Text } from '@mantine/core';
import { parseMarkdown } from '../lib/markdown';
import type { Span } from '../lib/markdown';

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.bold) return <strong key={i}>{s.text}</strong>;
        if (s.italic) return <em key={i}>{s.text}</em>;
        return <Fragment key={i}>{s.text}</Fragment>;
      })}
    </>
  );
}

export function SummaryMarkdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <Stack gap={6} style={{ overflowWrap: 'anywhere' }}>
      {blocks.map((b, i) => {
        if (b.type === 'h2' || b.type === 'h3') {
          return (
            <Text key={i} fw={700} size={b.type === 'h2' ? 'md' : 'sm'} mt={i === 0 ? 0 : 4}>
              <Spans spans={b.spans} />
            </Text>
          );
        }
        if (b.type === 'ul') {
          return (
            <List key={i} size="sm" spacing={2} withPadding>
              {b.items.map((item, j) => (
                <List.Item key={j}>
                  <Spans spans={item} />
                </List.Item>
              ))}
            </List>
          );
        }
        return (
          <Text key={i} size="sm">
            <Spans spans={b.spans} />
          </Text>
        );
      })}
    </Stack>
  );
}
