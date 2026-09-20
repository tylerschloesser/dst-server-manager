// @dst/supervisor tasks: session logs, scrubbed, and the manifest (docs/game-server.md §10,
// docs/storage.md §8). Every file scrubbed by exact match (`grep -F` equivalent) against the
// token and password values before upload (decisions §16.22) — never a partial/regex match, so
// scrubbing can never itself leak a hint about the secret's shape.
import { readFile } from 'node:fs/promises';

import type { ObjectPort, SessionManifest } from '../core';

const REDACTED_LINE = '*** REDACTED ***';

function scrubText(text: string, secrets: readonly string[]): string {
  const nonEmptySecrets = secrets.filter((s) => s.length > 0);
  if (nonEmptySecrets.length === 0) return text;
  return text
    .split('\n')
    .map((line) => (nonEmptySecrets.some((secret) => line.includes(secret)) ? REDACTED_LINE : line))
    .join('\n');
}

async function scrubFileIfPresent(
  path: string,
  secrets: readonly string[],
): Promise<Buffer | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null; // missing file (e.g. no chat this session) is not fatal
  }
  return Buffer.from(scrubText(text, secrets), 'utf8');
}

export interface UploadSessionLogsInput {
  readonly worldId: string;
  readonly sessionId: string;
  readonly hasCaves: boolean;
  readonly clusterDir: string;
  readonly supervisorLogPath: string;
  /** Revealed token + password values (docs/game-server.md §10) — never logged themselves. */
  readonly secretsToScrub: readonly string[];
  readonly manifest: SessionManifest;
  readonly objects: ObjectPort;
}

export async function uploadSessionLogs(input: UploadSessionLogsInput): Promise<void> {
  const prefix = `sessions/${input.worldId}/${input.sessionId}`;

  const files: Array<{ path: string; key: string }> = [
    { path: `${input.clusterDir}/Master/server_log.txt`, key: `${prefix}/master/server_log.txt` },
    {
      path: `${input.clusterDir}/Master/server_chat_log.txt`,
      key: `${prefix}/master/server_chat_log.txt`,
    },
  ];
  if (input.hasCaves) {
    files.push(
      { path: `${input.clusterDir}/Caves/server_log.txt`, key: `${prefix}/caves/server_log.txt` },
      {
        path: `${input.clusterDir}/Caves/server_chat_log.txt`,
        key: `${prefix}/caves/server_chat_log.txt`,
      },
    );
  }
  files.push({ path: input.supervisorLogPath, key: `${prefix}/supervisor.log` });

  for (const file of files) {
    const body = await scrubFileIfPresent(file.path, input.secretsToScrub);
    if (body === null) continue;
    await input.objects.putObject(file.key, body);
  }

  const manifestBody = Buffer.from(JSON.stringify(input.manifest, null, 2), 'utf8');
  await input.objects.putObject(`${prefix}/manifest.json`, manifestBody);
}
