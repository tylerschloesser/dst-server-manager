import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { Recap } from '@dst/shared';

import { digestSession } from '../core/digest';
import { scenarioInput } from '../test-support/scenario';
import { DEFAULT_VARIANT, PROMPT_VARIANTS } from './prompts';
import { DEFAULT_MODEL, MODELS, SUMMARY_TIMEOUT_MS, summarize } from './summarize';
import type { SummarizeInput } from './summarize';

const NOW = new Date('2026-01-02T00:00:00.000Z');

function mockClient(impl: (...args: unknown[]) => unknown) {
  const create = vi.fn(impl);
  const client = { beta: { messages: { create } } } as unknown as NonNullable<
    SummarizeInput['client']
  >;
  return { create, client };
}

function response(over: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'hidden reasoning', signature: 'x' },
      { type: 'text', text: '  **Where things stand**\n' },
      { type: 'text', text: '- Day 9, summer.  ' },
    ],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 40,
    },
    ...over,
  };
}

describe('summarize', async () => {
  const { recap } = await digestSession(scenarioInput());
  const prevRecap: Recap = { ...recap, sessionId: '20251231T000000Z-prev01' };
  const base = (over: Partial<SummarizeInput> = {}): SummarizeInput => ({
    recap,
    notes: ['finish the farm'],
    previous: [{ recap: prevRecap, summary: 'Last time you built a farm.' }],
    apiKey: null,
    now: () => NOW,
    ...over,
  });

  it('ok: joins text blocks, maps usage, computes cost, records version and context sessions', async () => {
    const { create, client } = mockClient(async () => response());
    const r = await summarize(base({ client }));
    expect(r.text).toBe('**Where things stand**\n- Day 9, summer.');
    expect(r.meta).toEqual({
      status: 'ok',
      model: 'claude-opus-5',
      promptVersion: DEFAULT_VARIANT.version,
      generatedAt: NOW.toISOString(),
      latencyMs: expect.any(Number),
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 40,
      },
      // (1000 + 40*1.25 + 100*0.1) * $5/M + 200 * $25/M
      costUsd: 0.0103,
      contextSessions: ['20251231T000000Z-prev01'],
    });
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      { timeout: number; signal: AbortSignal },
    ];
    expect(params).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: expect.any(Number),
      system: DEFAULT_VARIANT.system,
      messages: [{ role: 'user', content: r.context }],
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(options.timeout).toBe(SUMMARY_TIMEOUT_MS);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(r.context).toContain('Last time you built a farm.');
    expect(r.context).toContain('finish the farm');
  });

  it('missing cache usage fields count as 0', async () => {
    const { client } = mockClient(async () =>
      response({ model: 'claude-haiku-4-5', usage: { input_tokens: 2_000_000, output_tokens: 0 } }),
    );
    const r = await summarize(base({ client, model: 'claude-haiku-4-5' }));
    expect(r.meta).toMatchObject({
      status: 'ok',
      usage: { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 2, // 2M input tokens at $1/M
    });
  });

  it('sends fallbacks/betas only for models that support them; effort omitted for haiku', async () => {
    for (const [id, cfg] of Object.entries(MODELS)) {
      const { create, client } = mockClient(async () => response({ model: id }));
      const r = await summarize(base({ client, model: id }));
      expect(r.meta.status).toBe('ok');
      const params = create.mock.calls[0]![0] as Record<string, unknown>;
      expect(params['model']).toBe(id);
      if (cfg.fallbacks) {
        expect(params['betas']).toEqual(['server-side-fallback-2026-07-01']);
        expect(params['fallbacks']).toBe('default');
      } else {
        expect(params).not.toHaveProperty('betas');
        expect(params).not.toHaveProperty('fallbacks');
      }
      if (cfg.effort === undefined) expect(params).not.toHaveProperty('output_config');
      else expect(params['output_config']).toEqual({ effort: cfg.effort });
    }
    expect(MODELS['claude-haiku-4-5']!.effort).toBeUndefined();
    expect(MODELS[DEFAULT_MODEL]!.fallbacks).toBe(true);
  });

  it('uses the variant: its system prompt, version and context options', async () => {
    const variant = PROMPT_VARIANTS['bullets-nohistory']!;
    const { create, client } = mockClient(async () => response());
    const r = await summarize(base({ client, variant }));
    expect((create.mock.calls[0]![0] as { system: string }).system).toBe(variant.system);
    expect(r.meta.promptVersion).toBe(variant.version);
    expect(r.meta).toMatchObject({ contextSessions: [] });
    expect(r.context).not.toContain('Last time you built a farm.');
  });

  it('no key and no client -> unavailable/no_api_key without calling anything', async () => {
    for (const apiKey of [null, undefined, '']) {
      const r = await summarize(base({ apiKey }));
      expect(r).toEqual({
        text: null,
        context: null,
        meta: {
          status: 'unavailable',
          reason: 'no_api_key',
          detail: null,
          promptVersion: DEFAULT_VARIANT.version,
          generatedAt: NOW.toISOString(),
        },
      });
    }
  });

  it('an unknown model -> unavailable/disabled without calling the client', async () => {
    const { create, client } = mockClient(async () => response());
    const r = await summarize(base({ client, model: 'claude-nope' }));
    expect(r.meta).toMatchObject({
      status: 'unavailable',
      reason: 'disabled',
      detail: 'unknown model claude-nope',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('API errors -> api_error with a short, secret-free detail', async () => {
    const apiErr = new Anthropic.APIError(529, { type: 'error' }, 'overloaded', undefined);
    for (const [err, detail] of [
      [apiErr, /^529 /],
      [new Error('socket hang up'), /^Error: socket hang up$/],
      ['a string', /^a string$/],
    ] as const) {
      const { client } = mockClient(async () => {
        throw err;
      });
      const r = await summarize(base({ client }));
      expect(r.text).toBeNull();
      expect(r.meta).toMatchObject({ status: 'unavailable', reason: 'api_error' });
      expect((r.meta as { detail: string }).detail).toMatch(detail);
      expect(r.context).not.toBeNull(); // the context was built and is kept for the lab
    }
  });

  it('a synchronous throw from the client is caught too', async () => {
    const { client } = mockClient(() => {
      throw new Error('sync');
    });
    await expect(summarize(base({ client }))).resolves.toMatchObject({
      meta: { reason: 'api_error' },
    });
  });

  it('timeouts -> timeout', async () => {
    const named = (name: string) => Object.assign(new Error('slow'), { name });
    for (const err of [
      new Anthropic.APIConnectionTimeoutError(),
      named('TimeoutError'),
      named('AbortError'),
    ]) {
      const { client } = mockClient(async () => {
        throw err;
      });
      const r = await summarize(base({ client, timeoutMs: 10 }));
      expect(r.meta).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    }
  });

  it('passes a custom timeout to the request options', async () => {
    const { create, client } = mockClient(async () => response());
    await summarize(base({ client, timeoutMs: 1234 }));
    expect((create.mock.calls[0]![1] as { timeout: number }).timeout).toBe(1234);
  });

  it('stop_reason refusal -> refusal; no text -> empty', async () => {
    const refused = mockClient(async () => response({ stop_reason: 'refusal' }));
    expect((await summarize(base({ client: refused.client }))).meta).toMatchObject({
      reason: 'refusal',
    });
    for (const content of [[], [{ type: 'text', text: '   \n ' }]]) {
      const empty = mockClient(async () => response({ content, stop_reason: 'max_tokens' }));
      const r = await summarize(base({ client: empty.client }));
      expect(r.text).toBeNull();
      expect(r.meta).toMatchObject({ reason: 'empty', detail: 'stop_reason max_tokens' });
    }
  });
});
