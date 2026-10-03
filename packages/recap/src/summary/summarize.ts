// The LLM "where you left off" summary (docs/decisions.md §18). One Messages API call per session.
//
// It NEVER throws: no key, an API error, a refusal or a timeout all return
// `{ text: null, meta: { status: 'unavailable', … } }`, so the deterministic digest is always
// written (the digest never fails because the LLM did). The API key is read by the caller (env
// locally, the optional SSM parameter in Lambda) and never logged.
import Anthropic from '@anthropic-ai/sdk';

import type { Recap, RecapSummaryMeta } from '@dst/shared';

import { buildContext } from './context';
import type { PreviousSession } from './context';
import { DEFAULT_VARIANT } from './prompts';
import type { PromptVariant } from './prompts';

export interface ModelConfig {
  id: string;
  /** $ per million tokens (first-party API list prices, claude-api skill table 2026-06-24). */
  inputPerMTok: number;
  outputPerMTok: number;
  /** `output_config.effort`; undefined for models without effort (Haiku 4.5). */
  effort?: 'low' | 'medium' | 'high';
  /** Server-side refusal fallback (`fallbacks: "default"`), where the model supports it. */
  fallbacks: boolean;
}

export const MODELS: Record<string, ModelConfig> = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    inputPerMTok: 5,
    outputPerMTok: 25,
    effort: 'low',
    fallbacks: true,
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    inputPerMTok: 2,
    outputPerMTok: 10,
    effort: 'low',
    fallbacks: false,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    inputPerMTok: 1,
    outputPerMTok: 5,
    fallbacks: false,
  },
};

export const DEFAULT_MODEL = 'claude-opus-5';
export const SUMMARY_TIMEOUT_MS = 90_000;
const MAX_TOKENS = 4_000; // adaptive thinking shares this budget; the answer itself is ~200 tokens

export interface SummarizeInput {
  recap: Recap;
  notes: string[];
  previous: PreviousSession[];
  apiKey: string | null | undefined;
  variant?: PromptVariant;
  model?: string;
  timeoutMs?: number;
  now?: () => Date;
  /** Injected in tests; built from `apiKey` otherwise. */
  client?: Pick<Anthropic, 'beta'>;
}

export interface SummarizeResult {
  text: string | null;
  meta: RecapSummaryMeta;
  /** The exact user message sent (for the prompt lab); null when nothing was sent. */
  context: string | null;
}

type Usage = Extract<RecapSummaryMeta, { status: 'ok' }>['usage'];

function costUsd(m: ModelConfig, usage: Usage): number {
  const input =
    usage.inputTokens + usage.cacheCreationInputTokens * 1.25 + usage.cacheReadInputTokens * 0.1;
  return (
    Math.round(((input * m.inputPerMTok + usage.outputTokens * m.outputPerMTok) / 1e6) * 1e6) / 1e6
  );
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError)
    return `${err.status ?? 'network'} ${err.constructor.name}`.slice(0, 200);
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

export async function summarize(input: SummarizeInput): Promise<SummarizeResult> {
  const variant = input.variant ?? DEFAULT_VARIANT;
  const now = input.now ?? (() => new Date());
  const unavailable = (
    reason: Extract<RecapSummaryMeta, { status: 'unavailable' }>['reason'],
    detail: string | null,
    context: string | null,
  ): SummarizeResult => ({
    text: null,
    meta: {
      status: 'unavailable',
      reason,
      detail,
      promptVersion: variant.version,
      generatedAt: now().toISOString(),
    },
    context,
  });

  if (
    input.client === undefined &&
    (input.apiKey === null || input.apiKey === undefined || input.apiKey === '')
  ) {
    return unavailable('no_api_key', null, null);
  }
  const model = MODELS[input.model ?? DEFAULT_MODEL];
  if (model === undefined)
    return unavailable('disabled', `unknown model ${input.model ?? ''}`, null);

  const { text: context, contextSessions } = buildContext(
    { recap: input.recap, notes: input.notes, previous: input.previous },
    variant.context,
  );
  const timeoutMs = input.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const client =
    input.client ?? new Anthropic({ apiKey: input.apiKey!, timeout: timeoutMs, maxRetries: 1 });

  const started = Date.now();
  try {
    const response = await client.beta.messages.create(
      {
        model: model.id,
        max_tokens: MAX_TOKENS,
        system: variant.system,
        messages: [{ role: 'user', content: context }],
        ...(model.effort !== undefined ? { output_config: { effort: model.effort } } : {}),
        ...(model.fallbacks
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      },
      { timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs + 5_000) },
    );
    const latencyMs = Date.now() - started;
    if (response.stop_reason === 'refusal') return unavailable('refusal', null, context);
    const text = response.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    if (text === '')
      return unavailable('empty', `stop_reason ${response.stop_reason ?? 'null'}`, context);
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      text,
      meta: {
        status: 'ok',
        model: response.model,
        promptVersion: variant.version,
        generatedAt: now().toISOString(),
        latencyMs,
        usage,
        costUsd: costUsd(model, usage),
        contextSessions,
      },
      context,
    };
  } catch (err) {
    const timedOut =
      err instanceof Anthropic.APIConnectionTimeoutError ||
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'));
    return unavailable(timedOut ? 'timeout' : 'api_error', describe(err), context);
  }
}
