#!/usr/bin/env -S pnpm tsx
// scripts/mint-cookie.ts — docs/testing.md §5.1, decisions §16.33. The only way to drive the real
// API from the CLI: scripts/lifecycle-test.ts refuses every non-`test-` world id by design. Reads
// the real secret from SSM with the admin profile and mints a prod session cookie; never imports
// @dst/api/test-secret. Prints only the `Cookie:` header value — never the secret, the SteamID64,
// the allowlist, or the token on its own.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { CONTROL_REGION, PARAM_SESSION_SECRET, PARAM_USERS, PUBLIC_ORIGIN_PROD } from '@dst/shared';

// Importing the SSM SDK class above makes no network call and constructs no client (that happens
// only inside main(), after the --help / AWS_PROFILE checks below — decisions §16.40).

export const USAGE = `Usage: pnpm tsx scripts/mint-cookie.ts [--steam-id <steamid64>] [--help]

Mints a __Host-dst_session cookie for an allowlisted user, signed with the real
/dst/session-secret (SSM, us-east-1, AWS_PROFILE=admin). Prints only the Cookie header value.

Flags:
  --steam-id <steamid64>   which allowlisted user to mint for. Default: the first key of
                            /dst/users. A value not present in /dst/users is refused.
  --help                    print this message and exit 0. Makes no AWS call.
`;

export interface MintCookieArgs {
  help: false;
  steamId: string | null;
}

/** Pure argument parsing — no filesystem or network access. */
export function parseArgs(argv: string[]): { help: true } | MintCookieArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  let steamId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--steam-id') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--steam-id requires a value');
      steamId = v;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help: false, steamId };
}

async function main(): Promise<number> {
  let args: { help: true } | MintCookieArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${USAGE}\nError: ${(err as Error).message}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (process.env['AWS_PROFILE'] !== 'admin') {
    process.stderr.write('REFUSED: AWS_PROFILE=admin is required to run scripts/mint-cookie.ts\n');
    return 1;
  }

  // Module-load assertions in @dst/api/auth's index.ts (docs/auth.md §0) require APP_ENV and
  // PUBLIC_ORIGIN to already be set; a dynamic import (after setting them, below) guarantees that
  // ordering regardless of static-import hoisting.
  process.env['APP_ENV'] = 'prod';
  process.env['PUBLIC_ORIGIN'] = PUBLIC_ORIGIN_PROD;

  const { deriveSessionKey, mintSessionToken } = await import('@dst/api/auth');

  const ssm = new SSMClient({ region: CONTROL_REGION });

  const [secretResp, usersResp] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: PARAM_SESSION_SECRET, WithDecryption: true })),
    ssm.send(new GetParameterCommand({ Name: PARAM_USERS })),
  ]);

  const secret = secretResp.Parameter?.Value;
  if (secret === undefined || secret === '') {
    process.stderr.write('missing session secret\n');
    return 1;
  }

  const usersRaw = usersResp.Parameter?.Value;
  if (usersRaw === undefined) {
    process.stderr.write('missing /dst/users\n');
    return 1;
  }

  let users: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(usersRaw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    users = parsed as Record<string, unknown>;
  } catch {
    process.stderr.write('malformed /dst/users JSON\n');
    return 1;
  }

  const steamId = args.steamId ?? Object.keys(users)[0];
  if (steamId === undefined) {
    process.stderr.write('/dst/users is empty\n');
    return 1;
  }
  if (!Object.hasOwn(users, steamId)) {
    process.stderr.write('that SteamID64 is not in /dst/users\n');
    return 1;
  }

  const sessionKey = deriveSessionKey(secret, 'prod');
  const token = mintSessionToken({
    steamId64: steamId,
    sessionKey,
    nowSec: Math.floor(Date.now() / 1000),
  });

  process.stdout.write(`__Host-dst_session=${token}\n`);
  return 0;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
