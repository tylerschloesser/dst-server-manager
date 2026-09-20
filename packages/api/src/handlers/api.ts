// Lambda entry for the API Function URL (docs/control-plane.md §5.2, §16.39). Thin wiring only —
// construct the adapters, the SSM `SecretSource`, the router, export `handler`. All routing and
// business logic lives in `../router.ts` and `../routes/`; all auth logic lives in `../auth/`.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { CONTROL_REGION, PARAM_SESSION_SECRET, PARAM_USERS } from '@dst/shared';

import type { AllowlistSource, AuthDeps, SecretSource } from '../auth';
import { createAuthIdentity } from '../adapters/auth-identity';
import { createDynamoDocumentClient, createDynamoStateStore } from '../adapters/dynamo-state-store';
import { createDynamoWorldRegistry } from '../adapters/dynamo-world-registry';
import { createEc2Launcher } from '../adapters/ec2-launcher';
import { createSsmParameterStore } from '../adapters/ssm-parameter-store';
import { systemClock } from '../adapters/system-clock';
import { createRouter } from '../router';

const ssmClient = new SSMClient({ region: CONTROL_REGION });

// docs/auth.md §4: the secret arrives through a port; this is the only `SecretSource` in the
// Lambda's import graph. No caching here — `getSessionSecret` (T2.2) owns the TTL cache.
const sessionSecretSource: SecretSource = {
  async read(): Promise<string> {
    const res = await ssmClient.send(
      new GetParameterCommand({ Name: PARAM_SESSION_SECRET, WithDecryption: true }),
    );
    const value = res.Parameter?.Value;
    if (value === undefined || value === '') throw new Error('missing session secret');
    return value;
  },
};

// docs/auth.md §7: `/dst/users` re-checked on every request; `../auth/allowlist.ts`'s
// `fetchAndValidate` owns the real caching and fail-closed classification — it distinguishes a
// malformed parameter (logged, not cached) from a genuinely empty allowlist (also `{}`, but never
// logged as an error). That classification only works if this adapter reports failure by
// *throwing*, not by swallowing it into a fake-valid `{}` (defect 10): a malformed `/dst/users`
// must be distinguishable from "nobody is allowed" and visible in the logs, while staying
// fail-closed end to end (`fetchAndValidate` never caches a thrown/rejected read).
export function createAllowlistSource(client: SSMClient = ssmClient): AllowlistSource {
  return {
    async getUsers(): Promise<Record<string, string>> {
      const res = await client.send(new GetParameterCommand({ Name: PARAM_USERS }));
      const value = res.Parameter?.Value;
      if (value === undefined || value === '') {
        throw new Error('SSM parameter /dst/users has no value');
      }
      // JSON.parse throws SyntaxError on malformed JSON, which allowlist.ts classifies as
      // reason 'json'. A non-object parse result (array, string, number, null) is a distinct
      // failure, thrown here so the same classification (docs/auth.md §7 reason 'ssm') applies
      // rather than being silently coerced into an empty-but-"valid" map.
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('/dst/users value is not a JSON object');
      }
      return parsed as Record<string, string>;
    },
  };
}

const allowlistSource: AllowlistSource = createAllowlistSource();

const authDeps: AuthDeps = {
  secrets: sessionSecretSource,
  users: allowlistSource,
  nowMs: () => Date.now(),
  fetchSteam: fetch,
};

const documentClient = createDynamoDocumentClient();

const router = createRouter({
  clock: systemClock,
  store: createDynamoStateStore(documentClient),
  registry: createDynamoWorldRegistry(documentClient),
  params: createSsmParameterStore(),
  launcher: createEc2Launcher(),
  identity: createAuthIdentity(authDeps),
  auth: authDeps,
  publicOrigin: process.env['PUBLIC_ORIGIN'] ?? '',
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const res = await router.handle(event);
  return {
    statusCode: res.status,
    headers: res.headers,
    cookies: res.cookies,
    body: res.body,
    isBase64Encoded: res.isBase64Encoded ?? false,
  };
};
