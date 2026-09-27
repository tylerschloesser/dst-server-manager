// A local, offline `SessionSource` (docs/testing.md): the same layout as the bucket, rooted at a
// directory, so `aws s3 sync`/`s3api get-object` output can be digested with no credentials.
//
//   <root>/sessions/<worldId>/<sessionId>/manifest.json, master/…, caves/…
//   <root>/worlds/<worldId>/<versionId>.tar.zst          (one file per S3 object version)
//   <digestRoot>/sessions/<worldId>/<sessionId>/digest/… (defaults to <root>)
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManifestLike } from '../core/digest';
import type { DigestFile } from '../core/digest';
import type { SessionSource } from '../pipeline';

async function readOrNull(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function localSaveVersionPath(root: string, worldId: string, versionId: string): string {
  return path.join(root, 'worlds', worldId, `${versionId}.tar.zst`);
}

export function createFsSource(root: string, digestRoot: string = root): SessionSource {
  const sessionDir = (w: string, s: string) => path.join(root, 'sessions', w, s);
  return {
    async listSessions(worldId) {
      try {
        const names = await readdir(path.join(root, 'sessions', worldId), { withFileTypes: true });
        return names
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
    async readManifest(worldId, sessionId) {
      const buf = await readOrNull(path.join(sessionDir(worldId, sessionId), 'manifest.json'));
      return buf === null ? null : (JSON.parse(buf.toString('utf8')) as ManifestLike);
    },
    async readText(worldId, sessionId, relPath) {
      const buf = await readOrNull(path.join(sessionDir(worldId, sessionId), relPath));
      return buf === null ? null : buf.toString('utf8');
    },
    async readSaveVersion(worldId, versionId) {
      return readOrNull(localSaveVersionPath(root, worldId, versionId));
    },
    async readDigestFile(worldId, sessionId, name) {
      return readOrNull(path.join(digestRoot, 'sessions', worldId, sessionId, 'digest', name));
    },
  };
}

/** Writes digest files under `<digestRoot>/sessions/<w>/<s>/digest/`. */
export async function writeDigestLocally(
  digestRoot: string,
  worldId: string,
  sessionId: string,
  files: DigestFile[],
): Promise<string> {
  const dir = path.join(digestRoot, 'sessions', worldId, sessionId, 'digest');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId) || !/^[a-z0-9-]{1,32}$/.test(worldId)) {
    throw new Error(`refusing to write for ${worldId}/${sessionId}`);
  }
  // Validate every path before writing any, like the S3 writer.
  const targets = files.map((f) => {
    const target = path.join(dir, f.path);
    if (!target.startsWith(dir + path.sep)) throw new Error(`refusing to write outside ${dir}`);
    return target;
  });
  for (const [i, f] of files.entries()) {
    await mkdir(path.dirname(targets[i]!), { recursive: true });
    await writeFile(targets[i]!, f.body);
  }
  return dir;
}
