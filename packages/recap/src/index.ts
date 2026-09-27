// @dst/recap: the session digest (docs/decisions.md §18). `core/` is pure (bytes in, recap out,
// no AWS); `summary/` is the optional LLM layer; `handlers/` and `adapters/` wire it to AWS.
export { DIGEST_VERSION, digestSession } from './core/digest';
export type { DigestFile, DigestInput, DigestOutput, ManifestLike } from './core/digest';
export { SaveFormatError, configureLuaWasm } from './core/lua';
export type { SessionLogs } from './core/logs';
