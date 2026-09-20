// @dst/supervisor core: INI editing (docs/game-server.md §5 "Enforced every boot"). Every
// function here operates on an in-memory string and returns a new string — no file is ever
// touched by core/; the caller (a later task) reads/writes the actual file. Editing is
// line-based and never re-serializes the whole file, so untouched keys, comments, blank lines and
// key order are always preserved byte-for-byte.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionHeaderRe(section: string): RegExp {
  return new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`);
}

function keyLineRe(key: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
}

interface SectionRange {
  /** Index of the `[section]` header line. */
  readonly start: number;
  /** Index one past the section's last line (the next header, or `lines.length`). */
  readonly end: number;
}

function findSection(lines: readonly string[], section: string): SectionRange | null {
  const headerRe = sectionHeaderRe(section);
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[.+\]\s*$/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function findKeyInSection(
  lines: readonly string[],
  range: SectionRange,
  key: string,
): number | null {
  const re = keyLineRe(key);
  for (let i = range.start + 1; i < range.end; i++) {
    if (re.test(lines[i] ?? '')) return i;
  }
  return null;
}

/**
 * Sets `key = value` inside `[section]`. If the key already exists in that section its line is
 * replaced in place (comments, other keys and order are untouched); otherwise the line is
 * appended at the end of the section. If the section itself does not exist, it is appended (with
 * one key) at the end of the file.
 */
export function setIniKeyInSection(
  content: string,
  section: string,
  key: string,
  value: string,
): string {
  const lines = content.split('\n');
  const range = findSection(lines, section);

  if (range === null) {
    const trailingBlank = lines.length > 0 && lines[lines.length - 1] === '';
    const body = trailingBlank ? lines.slice(0, -1) : lines;
    const needsBlankSeparator = body.length > 0 && body[body.length - 1] !== '';
    const appended = [...body];
    if (needsBlankSeparator) appended.push('');
    appended.push(`[${section}]`, `${key} = ${value}`);
    if (trailingBlank) appended.push('');
    return appended.join('\n');
  }

  const existing = findKeyInSection(lines, range, key);
  const next = [...lines];
  if (existing !== null) {
    next[existing] = `${key} = ${value}`;
  } else {
    // Insert right after the section's last non-blank line, ahead of any trailing blank
    // separator line(s) before the next section header — reads as part of the section, not as a
    // dangling line in the gap before `[NextSection]`.
    let insertAt = range.end;
    while (insertAt > range.start + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
      insertAt--;
    }
    next.splice(insertAt, 0, `${key} = ${value}`);
  }
  return next.join('\n');
}

/**
 * Reads `key` from `[section]`, or `null` when either is absent. Trims surrounding whitespace
 * from the value (but not from inside it).
 */
export function readIniKey(content: string, section: string, key: string): string | null {
  const lines = content.split('\n');
  const range = findSection(lines, section);
  if (range === null) return null;
  const found = findKeyInSection(lines, range, key);
  if (found === null) return null;
  const line = lines[found] ?? '';
  const eq = line.indexOf('=');
  return eq === -1 ? null : line.slice(eq + 1).trim();
}

/**
 * Sets `key = value` in whichever section already holds it (searched across the whole file, not
 * just `fallbackSection`); if the key is not present anywhere, it is appended to `fallbackSection`
 * (docs/game-server.md §5: `cluster_password` "replaced in whichever section already holds the
 * key, else appended to `[NETWORK]`").
 */
export function setIniKeyAnywhereOrInSection(
  content: string,
  key: string,
  value: string,
  fallbackSection: string,
): string {
  const lines = content.split('\n');
  const re = keyLineRe(key);
  const idx = lines.findIndex((line) => re.test(line));
  if (idx === -1) {
    return setIniKeyInSection(content, fallbackSection, key, value);
  }
  const next = [...lines];
  next[idx] = `${key} = ${value}`;
  return next.join('\n');
}

// -------------------------------------------------------------------------------------------
// Domain-specific enforcement (docs/game-server.md §5 "Enforced every boot, restored or
// generated"). Each function is a thin, named wrapper so the call sites in tasks/ read like the
// doc's checklist.
// -------------------------------------------------------------------------------------------

/** `cluster.ini [MISC] console_enabled = true` (decisions §5). */
export function enforceConsoleEnabled(clusterIni: string): string {
  return setIniKeyInSection(clusterIni, 'MISC', 'console_enabled', 'true');
}

/** `cluster.ini [NETWORK] cluster_name` = the registry `serverName`. */
export function enforceClusterName(clusterIni: string, serverName: string): string {
  return setIniKeyInSection(clusterIni, 'NETWORK', 'cluster_name', serverName);
}

/**
 * `cluster_password` = the revealed SSM value, replaced in whichever section already holds the
 * key, else appended to `[NETWORK]`. The caller passes the already-revealed plaintext; this
 * function never touches `Secret.reveal()` itself (docs/game-server.md §10 keeps that call site
 * to the INI writer and the token-file writer only).
 */
export function enforceClusterPassword(clusterIni: string, password: string): string {
  return setIniKeyAnywhereOrInSection(clusterIni, 'cluster_password', password, 'NETWORK');
}

/** `Caves/server.ini [SHARD] id = CAVES_SHARD_ID` (pinned, decisions §5). */
export function enforceCavesShardId(cavesServerIni: string, cavesShardId: number): string {
  return setIniKeyInSection(cavesServerIni, 'SHARD', 'id', String(cavesShardId));
}

/**
 * `pause_when_empty` is read, not enforced (docs/game-server.md §5): `null` when the key or
 * section is absent, which callers must treat the same as "not `true`" (disable the cross-check).
 */
export function readPauseWhenEmpty(clusterIni: string): boolean | null {
  const value = readIniKey(clusterIni, 'GAMEPLAY', 'pause_when_empty');
  if (value === null) return null;
  return value === 'true';
}
