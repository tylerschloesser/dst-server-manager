#!/usr/bin/env node
// CDK app entry (docs/infra.md §1.1). Every path CDK reads off disk is context-resolvable
// (decisions §16.30), so tests and the fixture synth never depend on another package having been
// built.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { ACCOUNT_ID, CONTROL_REGION, GAME_REGION, PROJECT } from '@dst/shared';
import { DstCiStack } from '../lib/ci-stack';
import { DstGameStack } from '../lib/game-stack';
import { DstWebStack } from '../lib/web-stack';

// This file runs under `tsx` as an ES module (package.json has "type": "module"), which does not
// provide the CJS `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

/** A relative -c value is resolved against the package root (packages/infra). */
const p = (key: string, dflt: string): string => {
  const v = app.node.tryGetContext(key) as string | undefined;
  return v ? path.resolve(__dirname, '..', v) : path.resolve(__dirname, dflt);
};

const webEnv = { account: ACCOUNT_ID, region: CONTROL_REGION }; // 063257577013 / us-east-1
const gameEnv = { account: ACCOUNT_ID, region: GAME_REGION }; // 063257577013 / us-west-2

new DstCiStack(app, 'DstCi', { env: webEnv, stackName: 'DstCi' });
const game = new DstGameStack(app, 'DstGame', {
  env: gameEnv,
  stackName: 'DstGame',
  supervisorBundlePath: p('supervisorBundlePath', '../../supervisor/dist/runtime'),
  userDataPath: p('userDataPath', '../../supervisor/assets/user-data.sh'),
});
const web = new DstWebStack(app, 'DstWeb', {
  env: webEnv,
  stackName: 'DstWeb',
  apiBundlePath: p('apiBundlePath', '../../api/dist/lambda'),
  webDistPath: p('webDistPath', '../../web/dist'),
  budgetEnabled: app.node.tryGetContext('budgetEnabled') !== 'false',
});

web.addDependency(game); // ordering only; no cross-region references (§5)
cdk.Tags.of(app).add('project', PROJECT);
