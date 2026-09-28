#!/usr/bin/env -S pnpm tsx
// scripts/mint-guest-link.ts — docs/auth.md §12.5. Mints a read-only guest link for someone who is
// not on /dst/users: they see the world list, status, recaps and maps, and every write is refused
// with 403 `read_only`. Signed with the guest key derived from the real /dst/session-secret (SSM,
// us-east-1, AWS_PROFILE=admin); no new secret, no stored state. Prints only the link. Never
// commit a printed link: it is a credential until it expires.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { CONTROL_REGION, PARAM_SESSION_SECRET, PUBLIC_ORIGIN_PROD } from '@dst/shared';

// Importing the SSM SDK class above makes no network call and constructs no client (that happens
// only inside main(), after the --help / AWS_PROFILE checks below — decisions §16.40).

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 30;

export const USAGE = `Usage: pnpm tsx scripts/mint-guest-link.ts --label <name> [--days <n>] [--help]

Mints a read-only guest link to ${PUBLIC_ORIGIN_PROD}, signed with a key derived from the
real /dst/session-secret (SSM, us-east-1, AWS_PROFILE=admin). Prints only the link.
The holder sees everything a friend sees except the server password; nothing they
click can change anything. The link stops working after --days; to kill every link
early, rotate the session secret (docs/auth.md §10 — this also signs out members).

Flags:
  --label <name>   required. A tag for the logs (auth.guest events), [a-z0-9-]{1,32}.
  --days <n>       whole days until the link expires, 1..${MAX_DAYS}. Default ${DEFAULT_DAYS}.
  --help           print this message and exit 0. Makes no AWS call.
`;

export interface MintGuestLinkArgs {
  help: false;
  label: string;
  days: number;
}

/** Pure argument parsing — no filesystem or network access. */
export function parseArgs(argv: string[]): { help: true } | MintGuestLinkArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  let label: string | null = null;
  let days = DEFAULT_DAYS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label' || arg === '--days') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--label') {
        if (!/^[a-z0-9-]{1,32}$/.test(v)) throw new Error('--label must match [a-z0-9-]{1,32}');
        label = v;
      } else {
        if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > MAX_DAYS) {
          throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
        }
        days = Number(v);
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (label === null) throw new Error('--label is required');
  return { help: false, label, days };
}

async function main(): Promise<number> {
  let args: { help: true } | MintGuestLinkArgs;
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
    process.stderr.write(
      'REFUSED: AWS_PROFILE=admin is required to run scripts/mint-guest-link.ts\n',
    );
    return 1;
  }

  // Module-load assertions in @dst/api/auth's index.ts (docs/auth.md §0) require APP_ENV and
  // PUBLIC_ORIGIN to already be set; a dynamic import (after setting them) guarantees the order.
  process.env['APP_ENV'] = 'prod';
  process.env['PUBLIC_ORIGIN'] = PUBLIC_ORIGIN_PROD;

  const { deriveGuestKey, mintGuestToken } = await import('@dst/api/auth');

  const ssm = new SSMClient({ region: CONTROL_REGION });
  const secretResp = await ssm.send(
    new GetParameterCommand({ Name: PARAM_SESSION_SECRET, WithDecryption: true }),
  );
  const secret = secretResp.Parameter?.Value;
  if (secret === undefined || secret === '') {
    process.stderr.write('missing session secret\n');
    return 1;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ttlS = args.days * 86_400;
  const token = mintGuestToken({
    label: args.label,
    ttlS,
    guestKey: deriveGuestKey(secret, 'prod'),
    nowSec,
  });

  process.stdout.write(`${PUBLIC_ORIGIN_PROD}/api/auth/guest?t=${token}\n`);
  process.stderr.write(
    `guest link "${args.label}" expires ${new Date((nowSec + ttlS) * 1000).toISOString()}\n`,
  );
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
