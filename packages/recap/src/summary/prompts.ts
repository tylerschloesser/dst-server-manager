// The LLM summary's prompts (docs/decisions.md §18). Edit HERE to change what the summary says;
// bump the variant's `version` whenever its text or context options change, because the version
// is recorded in every `summary.json` and is how an old summary is told apart from a new one.
//
// `DEFAULT_VARIANT` is what the Lambda and the backfill use. The others are kept for the prompt
// lab (`pnpm tsx scripts/recap-prompt-lab.ts --variants …`) so a change can be compared side by
// side against real sessions before it becomes the default.
import { DEFAULT_CONTEXT_OPTIONS } from './context';
import type { ContextOptions } from './context';

export interface PromptVariant {
  id: string;
  version: string; // recorded in summary.json as `promptVersion`
  description: string;
  system: string;
  context: ContextOptions;
}

const PURPOSE = `You write the "where you left off" note for a small group of friends who play Don't Starve Together together on their own server. They read it on a phone right before their next session, often days later, to remember what they were in the middle of and decide what to do next.

The input is a fact sheet a program extracted from the world's save files and server logs: the session that just ended (<this_session>), the players' own "next time" note if they wrote one (<players_note>), and what earlier sessions looked like (<previous_sessions>).`;

const RULES = `Rules:
- Every fact must come from the input. Never invent events, places, items, bosses or goals.
- Anything that is your inference rather than a stated fact ends with "(inferred)". Plans come only from <players_note>; without a note, offer next steps as suggestions that follow from the facts, marked (inferred).
- Game knowledge is fine for implications (e.g. what the coming season needs), but tie it to the facts given and mark it (inferred).
- Prefer what matters for resuming: the season clock, where each player and the stuff is, dangers, unfinished work. Skip trivia (small storage changes, starting recipes, exact tile counts).
- Use the players' names exactly as given and the game's item names as given.
- If nobody played this session, say so in one short line, then carry forward where things stood from the previous sessions.
- If the world was restored from an older save, say so plainly: earlier progress may be missing.
- Attribute a thing to a player only when the input does (a structure is the group's, not one player's).
- Mention health, hunger or sanity only when one is low.
- No preamble, no sign-off, no emojis.`;

const BULLETS = `${PURPOSE}

Write Markdown in exactly this shape, 120 words at most in total (a hard limit), each bullet one line of at most 20 words:

**Where things stand**
- 2-3 bullets: the day and season and what is coming, where each player is, anything urgent.

**Last time**
- 2-3 bullets: what happened, most important first.

**Next up**
- 1-3 bullets: open threads and likely next steps.

Address the players as "you" (plural), naming a player when it matters who.

${RULES}`;

const PROSE = `${PURPOSE}

Write two or three short paragraphs of plain prose (at most 130 words in total): first where things stand now (season clock, where everyone and the stuff is, anything urgent), then what happened last time, then what is likely next. Address the players as "you" (plural), naming a player when it matters who.

${RULES}`;

const THIRD_PERSON = `${PURPOSE}

Write at most 130 words of Markdown in exactly this shape:

**Where things stand**
- 2-3 bullets.

**Last time**
- 2-3 bullets.

**Next up**
- 1-3 bullets.

Write in the third person, always naming the player ("Sam repaired the…"), never "you".

${RULES}`;

export const PROMPT_VARIANTS: Record<string, PromptVariant> = {
  bullets: {
    id: 'bullets',
    version: 'recap-bullets-v2',
    description:
      'Three headed bullet sections, second person, previous 2 summaries, brief inventory',
    system: BULLETS,
    context: DEFAULT_CONTEXT_OPTIONS,
  },
  'bullets-nohistory': {
    id: 'bullets-nohistory',
    version: 'recap-bullets-nohistory-v2',
    description: 'Same as bullets, without previous sessions (continuity off)',
    system: BULLETS,
    context: { ...DEFAULT_CONTEXT_OPTIONS, previous: 'none' },
  },
  'bullets-fullinv': {
    id: 'bullets-fullinv',
    version: 'recap-bullets-fullinv-v2',
    description: 'Same as bullets, with every inventory and backpack slot',
    system: BULLETS,
    context: { ...DEFAULT_CONTEXT_OPTIONS, inventory: 'full' },
  },
  'bullets-digests': {
    id: 'bullets-digests',
    version: 'recap-bullets-digests-v2',
    description: 'Same as bullets, previous sessions as compact fact sheets instead of summaries',
    system: BULLETS,
    context: { ...DEFAULT_CONTEXT_OPTIONS, previous: 'digests', previousCount: 3 },
  },
  prose: {
    id: 'prose',
    version: 'recap-prose-v2',
    description: 'Short paragraphs instead of bullets',
    system: PROSE,
    context: DEFAULT_CONTEXT_OPTIONS,
  },
  'third-person': {
    id: 'third-person',
    version: 'recap-third-v2',
    description: 'Bullets, third person with names',
    system: THIRD_PERSON,
    context: DEFAULT_CONTEXT_OPTIONS,
  },
};

export const DEFAULT_VARIANT_ID = 'bullets';
export const DEFAULT_VARIANT: PromptVariant = PROMPT_VARIANTS[DEFAULT_VARIANT_ID]!;
