import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('splits bold and both italic forms into spans', () => {
    expect(parseInline('Summer on **day 56**; _Overheating_ and *ice*.')).toEqual([
      { text: 'Summer on ' },
      { text: 'day 56', bold: true },
      { text: '; ' },
      { text: 'Overheating', italic: true },
      { text: ' and ' },
      { text: 'ice', italic: true },
      { text: '.' },
    ]);
  });

  it('leaves snake_case, lone asterisks and unclosed markers as literal text', () => {
    expect(parseInline('thulecite_pieces x 2 * 3 **open')).toEqual([
      { text: 'thulecite_pieces x 2 * 3 **open' },
    ]);
  });

  it('keeps HTML as literal text (the renderer never interprets it)', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('parses the summary shape: headings, one-level bullets, paragraphs', () => {
    const md = [
      '## Previously on World A',
      '- Summer arrived on **day 56**.',
      '- You built a Chest.',
      '',
      'A short paragraph',
      'that wraps.',
      '',
      '### Open threads',
      '* Ice is low (inferred)',
    ].join('\n');
    expect(parseMarkdown(md)).toEqual([
      { type: 'h2', spans: [{ text: 'Previously on World A' }] },
      {
        type: 'ul',
        items: [
          [{ text: 'Summer arrived on ' }, { text: 'day 56', bold: true }, { text: '.' }],
          [{ text: 'You built a Chest.' }],
        ],
      },
      { type: 'p', spans: [{ text: 'A short paragraph that wraps.' }] },
      { type: 'h3', spans: [{ text: 'Open threads' }] },
      { type: 'ul', items: [[{ text: 'Ice is low (inferred)' }]] },
    ]);
  });

  it('shows everything it does not support as plain paragraph text', () => {
    expect(parseMarkdown('# Big\n1. one\n[link](http://x)\r\n`code`')).toEqual([
      { type: 'p', spans: [{ text: '# Big 1. one [link](http://x) `code`' }] },
    ]);
  });

  it('a paragraph line after bullets ends the list', () => {
    expect(parseMarkdown('- a\nb')).toEqual([
      { type: 'ul', items: [[{ text: 'a' }]] },
      { type: 'p', spans: [{ text: 'b' }] },
    ]);
  });

  it('empty input is no blocks', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
  });
});
