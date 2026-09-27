// @dst/recap: the session digest (docs/decisions.md §18). `core/` is pure (bytes in, recap out,
// no AWS); `summary/` is the optional LLM layer; `pipeline.ts` is the one code path the Lambda,
// the scripts and the prompt lab share. AWS adapters live behind the `@dst/recap/aws` subpath.
export { DIGEST_VERSION, digestSession } from './core/digest';
export type { DigestFile, DigestInput, DigestOutput, ManifestLike } from './core/digest';
export { SaveFormatError, configureLuaWasm } from './core/lua';
export type { SessionLogs } from './core/logs';
export { SessionInputError, runPipeline } from './pipeline';
export type { NoteSource, PipelineInput, PipelineOutput, SessionSource } from './pipeline';
export { createFsSource, localSaveVersionPath, writeDigestLocally } from './adapters/fs-source';
export { DEFAULT_CONTEXT_OPTIONS, buildContext, factSheet } from './summary/context';
export type { ContextOptions, PreviousSession } from './summary/context';
export { DEFAULT_VARIANT, DEFAULT_VARIANT_ID, PROMPT_VARIANTS } from './summary/prompts';
export type { PromptVariant } from './summary/prompts';
export { DEFAULT_MODEL, MODELS, SUMMARY_TIMEOUT_MS, summarize } from './summary/summarize';
export type { ModelConfig, SummarizeInput, SummarizeResult } from './summary/summarize';
