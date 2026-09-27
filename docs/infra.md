# Infra: CDK stacks, DNS, CI/CD, tagging, budget

Domain doc for `packages/infra` and `.github/workflows/deploy.yml`. Source of truth is
[`decisions.md`](./decisions.md) §2, §3, §7, §10, §12, §13 — this doc elaborates, never overrides.
Siblings: `docs/storage.md` (bucket layout, lifecycle rationale, manual restore),
`docs/control-plane.md` (API/reaper behaviour **and their exact IAM statements**), `docs/auth.md`
(**the CSP string and every security header**, cookies, `APP_ENV`), `docs/game-server.md`
(user-data, the runtime bundle this stack deploys), `docs/web.md` (the `dist/` this stack uploads),
`docs/testing.md` (root scripts and the CI step list).

## 0. Hard constraints

- **The account `063257577013` hosts other production sites.** Nothing this project did not create
  may be created, modified or deleted: the hosted zone `ty.ler.dev`, the GitHub OIDC provider, both
  `CDKToolkit` stacks, every existing distribution/Lambda/bucket.
- **No default AWS profile, no default region.** Every **AWS CLI** call passes `AWS_PROFILE=admin`
  *and* `--region`. **`cdk` takes no `--region`** — every stack sets `env` explicitly, and the CDK
  v2 CLI rejects the unknown option (decisions §16.31).
- **Bootstrap**: us-east-1 v30, us-west-2 v18. Both sufficient (min 6 to deploy, min 8 for context
  lookups). **Do not re-bootstrap** — `docs/research/cdk-version.md` §3 suggests it; decisions.md
  overrules.
- **Public repo.** No SteamIDs, emails, tokens or passwords in `packages/infra`. The account id and
  zone id are already public in decisions.md and are fine.
- No global `cdk`: everything is `pnpm --filter @dst/infra exec cdk ...`. Root script names are
  owned by `docs/testing.md` §1; use those, not ad-hoc `pnpm -r` invocations.

## 1. Package layout

```
packages/infra/
  package.json      deps: aws-cdk-lib@2.270.0, constructs@10.8.1, @dst/shared@workspace:*
                    devDeps: aws-cdk@2.1142.0, tsx, vitest
  cdk.json          { "app": "pnpm exec tsx bin/app.ts", "context": { ...feature flags... } }
  cdk.context.json  COMMITTED (default-VPC lookup cache, §3.3)
  bin/app.ts        App, explicit envs, Tags.of(app), deploy ordering
  lib/{ci,game,web}-stack.ts        test/{ci,game,web}-stack.test.ts
  test/fixtures/api-bundle/api.js, test/fixtures/api-bundle/reaper.js
  test/fixtures/digest-bundle/digest.js
  test/fixtures/supervisor-bundle/install.sh
  test/fixtures/web-dist/index.html
  test/fixtures/user-data.sh, test/fixtures/node.env                         (§7)
```

**No bundler is a dependency of this package** (decisions §16.29): `esbuild` appears nowhere in
`packages/infra`, nothing is bundled during `cdk synth`, and no construct here can reach for
Docker. The Lambda code is a pre-built directory produced by `@dst/api` (§4.2) or, for the
session digest, by `@dst/recap` (§3.7).

Produce `cdk.json`'s feature-flag `context` block once by running `cdk init app --language
typescript` with `aws-cdk@2.1142.0` in a scratch dir and copying it. Do not hand-write flags.

### 1.1 `bin/app.ts`

```ts
const app = new cdk.App();
/** decisions §16.30: every path CDK reads off disk is context-resolvable, so tests and the
 *  fixture synth never depend on another package having been built. A relative -c value is
 *  resolved against the package root (packages/infra). */
const p = (key: string, dflt: string) => {
  const v = app.node.tryGetContext(key);
  return v ? path.resolve(__dirname, '..', v) : path.resolve(__dirname, dflt);
};
const webEnv  = { account: ACCOUNT_ID, region: CONTROL_REGION };  // 063257577013 / us-east-1
const gameEnv = { account: ACCOUNT_ID, region: GAME_REGION };     // 063257577013 / us-west-2

new DstCiStack(app, 'DstCi', { env: webEnv, stackName: 'DstCi' });
const game = new DstGameStack(app, 'DstGame', { env: gameEnv, stackName: 'DstGame',
  supervisorBundlePath: p('supervisorBundlePath', '../../supervisor/dist/runtime'),
  userDataPath:         p('userDataPath',         '../../supervisor/assets/user-data.sh'),
  digestBundlePath:     p('digestBundlePath',     '../../recap/dist/lambda') });
const web = new DstWebStack(app, 'DstWeb', { env: webEnv, stackName: 'DstWeb',
  apiBundlePath: p('apiBundlePath', '../../api/dist/lambda'),
  webDistPath:   p('webDistPath',   '../../web/dist'),
  budgetEnabled: app.node.tryGetContext('budgetEnabled') !== 'false' });

web.addDependency(game);                       // ordering only; no cross-region references (§5)
cdk.Tags.of(app).add('project', PROJECT);      // 'dst-server-manager'
```

`stackName` is explicit so CloudFormation stacks are exactly `DstCi` / `DstGame` / `DstWeb`.

**The five context paths** and their defaults (decisions §16.30), all relative to `packages/infra`:

| Context key | Default | What it is |
|---|---|---|
| `apiBundlePath` | `../api/dist/lambda` | the esbuild output deployed as both Lambdas' code (§4.2, `docs/control-plane.md` §5.2) |
| `supervisorBundlePath` | `../supervisor/dist/runtime` | the staged runtime bundle (`docs/game-server.md` §11) |
| `webDistPath` | `../web/dist` | `vite build` output (`docs/web.md` §8) |
| `userDataPath` | `../supervisor/assets/user-data.sh` | the user-data text baked into the launch template (§3.6) |
| `digestBundlePath` | `../recap/dist/lambda` | `@dst/recap`'s esbuild output: `digest.js`, `glue.wasm` and a `{"type":"commonjs"}` `package.json` (§3.7) |

`node.env` is read from **the same directory as `userDataPath`**, so one `-c` flag moves both
(§3.6). Nothing else in this package touches another package's files.

### 1.2 What `Tags.of(app)` does **not** reach

1. **EC2 instances and their volumes** — created by `RunInstances`, not CloudFormation. Tags are set
   in **two** places, both required: (a) the launch template's `TagSpecifications` for
   `resourceType: instance` and `volume`, which CDK's `ec2.LaunchTemplate` renders from the
   construct's own `TagManager` — so the app aspect plus `Tags.of(lt).add('role','game')` land there
   (§3.6); (b) the API's `RunInstances` call, which repeats the **full** set plus `sessionId` (a
   per-launch value no template can hold), because a request-level `TagSpecification` for a resource
   type may supersede rather than merge with the template's. Exact call: `docs/control-plane.md`.
   This is load-bearing: the reaper finds instances by `project`+`role` and its
   `ec2:TerminateInstances` permission is conditioned on `project`. An untagged instance is both
   invisible and un-killable.
2. **Imported resources** (hosted zone, OIDC provider) — references, never tagged.
3. **Data-plane objects** — S3 objects, DynamoDB items.
4. **Implicit Lambda log groups** — hence explicit `logs.LogGroup` constructs (§4.2).
5. The shared `CDKToolkit` stacks — never touched.

The SSM parameters are human-managed (§8) and were tagged by hand at creation; tag
`/dst/anthropic-api-key` the same way when it is created (`--tags Key=project,Value=dst-server-manager`).

## 2. `DstCi` (us-east-1) — GitHub OIDC deploy role

Deployed **once, locally, with `AWS_PROFILE=admin`**; the workflow never deploys it (it has no
credentials until this role exists).

```ts
const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc',
  `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`);

const bootstrapRoles = ['deploy-role', 'file-publishing-role', 'lookup-role'].flatMap((r) =>
  [CONTROL_REGION, GAME_REGION].map((g) => `arn:aws:iam::${ACCOUNT_ID}:role/cdk-hnb659fds-${r}-${ACCOUNT_ID}-${g}`));

const role = new iam.Role(this, 'GithubDeployRole', {
  roleName: 'dst-server-manager-github-deploy',
  maxSessionDuration: cdk.Duration.hours(1),
  assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub':
        // GitHub issues an IMMUTABLE subject for this repo (numeric owner/repo ids); the classic
        // `repo:<owner>/<repo>:ref:...` form is never presented. See decisions.md §12.
        'repo:tylerschloesser@2300885/dst-server-manager@1377732613:ref:refs/heads/main',
    },
  }),
});
role.addToPolicy(new iam.PolicyStatement({ sid: 'AssumeCdkBootstrapRoles',
  effect: iam.Effect.ALLOW, actions: ['sts:AssumeRole'], resources: bootstrapRoles }));
```

**Never** `new iam.OpenIdConnectProvider(...)`: the provider already exists and is shared; owning it
would let a `cdk destroy` break other sites. That `sts:AssumeRole` statement is the role's **only**
permission. Both conditions are `StringEquals`, never `StringLike` — so a PR, tag, fork or other
repo cannot assume it. `image-publishing-role` is omitted (no container assets). Deploy:

```bash
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk deploy DstCi --require-approval never
```

## 3. `DstGame` (us-west-2)

decisions.md §2's "No Lambdas" meant no *application* Lambdas; the session recap added exactly
**one**, the digest (§3.7), which runs only when a session's `manifest.json` lands and so costs
nothing idle. Two CDK-managed Lambdas are expected plumbing (decisions §16.16): the
`BucketDeployment` handler (§3.2) and the `Custom::S3BucketNotifications` handler that installs the
digest's trigger (§3.7). Test 27 pins the count at exactly those three.

### 3.1 Data bucket

Layout, lifecycle rationale and manual restore live in `docs/storage.md`. Constructs:

```ts
const data = new s3.Bucket(this, 'Data', {
  bucketName: DATA_BUCKET,                       // dst-server-manager-data-063257577013
  versioned: true, enforceSSL: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  // NO autoDeleteObjects — it provisions a Lambda whose only job is deleting this data.
  lifecycleRules: [
    { id: 'worlds-noncurrent', prefix: 'worlds/', enabled: true, expiredObjectDeleteMarker: true,
      noncurrentVersionExpiration: cdk.Duration.days(30), noncurrentVersionsToRetain: 10 },
    { id: 'inflight-noncurrent', prefix: 'inflight/', enabled: true, expiredObjectDeleteMarker: true,
      noncurrentVersionExpiration: cdk.Duration.days(7), noncurrentVersionsToRetain: 3 },
    // decisions §16.19: bucket-wide, aborts incomplete MPUs only, expires no object.
    { id: 'abort-mpu', enabled: true, abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
  ],
});
data.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'DenyDeleteOutsideScratchPrefixes', effect: iam.Effect.DENY,
  principals: [new iam.AnyPrincipal()],
  actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
  notResources: [`${data.bucketArn}/runtime/*`, `${data.bucketArn}/runtime-cache/*`,
    `${data.bucketArn}/binaries/*`, `${data.bucketArn}/worlds/test-*`,
    `${data.bucketArn}/inflight/test-*`, `${data.bucketArn}/sessions/test-*`],
}));
```

`noncurrentVersionsToRetain` renders as `NewerNoncurrentVersions`. The rule set and its rationale
are owned by `docs/storage.md` §2 — three rules, the third expiring nothing. `Deny` + `NotResource`
is safe because a bucket policy is only evaluated for its own bucket. `enforceSSL` adds a second
deny statement, so assertions must not assume one statement. Lifecycle is not subject to the policy
— that is how old versions still age out. No `seed/` or `sessions/` expiration rule.

### 3.2 Supervisor runtime bundle

```ts
new s3deploy.BucketDeployment(this, 'Runtime', {
  sources: [s3deploy.Source.asset(props.supervisorBundlePath)],
  destinationBucket: data, destinationKeyPrefix: 'runtime',
  prune: true, retainOnDelete: true, memoryLimit: 512,
});
```

`prune: true` deletes destination objects absent from the source, but it lists and prunes **only
under `destinationKeyPrefix`** — that prefix is the safety boundary that keeps it away from
`worlds/`, `seed/`, `binaries/`. The deny-delete policy exempts `runtime/*` so prune succeeds there
and would be blocked anywhere else: a second, independent net. `Source.asset` reads the bundle at
**synth** time and throws if the path is missing, so `pnpm --filter @dst/supervisor build` (part of
`pnpm build`, which builds every package before `cdk synth` — §5) must precede any real
synth/diff/deploy; tests and the fixture synth pass `-c supervisorBundlePath=…` instead (§7).

### 3.3 Default VPC lookup

`const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });` — both regions have one.
This is a **context lookup**: run the one credentialed fixture synth of §5 once locally with
`AWS_PROFILE=admin` and **commit the generated `cdk.context.json`**, so CI synthesises with no AWS
call. Leave the file in the working tree for whoever is driving the commits. Without the file CI
would assume the bootstrap `lookup-role` (v18 ≥ the v8 minimum, so it does work) — the committed
file is preferred for determinism. To refresh: `cdk context --clear`, re-synth locally, re-commit.

### 3.4 Security group

```ts
const sg = new ec2.SecurityGroup(this, 'GameSg', { vpc,
  securityGroupName: 'dst-server-manager-game',
  description: 'DST shards: UDP 10998 (Caves) and 10999 (Master)', allowAllOutbound: true });
sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udpRange(10998, 10999), 'DST Master/Caves');
```

Exactly one ingress rule. No TCP, **no port 22** (access is SSM Session Manager only), no IPv6
ingress. Egress stays open: steamcmd, Klei, S3, SSM, DynamoDB, nodejs.org.

### 3.5 Instance role and profile

`new iam.Role(this, 'InstanceRole', { roleName: 'dst-server-manager-instance', assumedBy: new
iam.ServicePrincipal('ec2.amazonaws.com'), managedPolicies:
[iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')] })`, plus one
`addToPolicy` per row:

| Sid | Actions | Resources / conditions |
|---|---|---|
| `ReadRuntimeAndBinaries` | `s3:GetObject`, `s3:GetObjectVersion` | `<data>/runtime/*`, `<data>/runtime-cache/*`, `<data>/binaries/*` |
| `ReadSaves` | `s3:GetObject`, `s3:GetObjectVersion` | `<data>/worlds/*` (**not** `inflight/*`, which is write-only for the instance) |
| `WriteSavesSessionsAndCaches` | `s3:PutObject` | `<data>/worlds/*`, `<data>/inflight/*`, `<data>/sessions/*`, `<data>/binaries/*`, `<data>/runtime-cache/*` |
| `ListDataPrefixes` | `s3:ListBucket` | `<data>` + `StringLike { "s3:prefix": ["runtime/*","runtime-cache/*","binaries/*","worlds/*","inflight/*","sessions/*"] }` |
| `State` | `dynamodb:GetItem`, `dynamodb:UpdateItem` | `arn:aws:dynamodb:us-east-1:063257577013:table/dst-server-manager` (cross-region, by ARN) |
| `Secrets` | `ssm:GetParameter` | `arn:aws:ssm:us-west-2:063257577013:parameter/dst/klei-token`, `…/parameter/dst/cluster-password` |
| `DecryptSecrets` | `kms:Decrypt` | `*` + `StringEquals { "kms:ViaService": "ssm.us-west-2.amazonaws.com" }` |
| `JoinDnsRecord` | `route53:ChangeResourceRecordSets` | `arn:aws:route53:::hostedzone/Z038502736IM0QLQT7VFN` + `ForAllValues:StringEquals { "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["play.dst.ty.ler.dev"], "route53:ChangeResourceRecordSetsRecordTypes": ["A"] }` |

This is exactly what `docs/game-server.md` and `docs/storage.md` §4 say the instance needs, and
nothing more. In particular: **no `/dst/users`** — the instance never reads the allowlist
(decisions §16.6), the nickname arrives on the state item as `startedByNickname`. No `s3:Delete*`
anywhere. **No access to `seed/`** — the seed zip is read only by
`scripts/import-world.ts` under the admin profile. **No `ec2:*` at all**, so in particular no
`ec2:CreateTags` (decisions §16.7: the instance is never re-tagged, not even on an in-place world
switch) and no `ec2:DescribeTags` (the `sessionId` tag arrives via IMDS); the instance ends itself
via `shutdown -h now` + terminate-on-shutdown. The one non-S3/DynamoDB/SSM permission is
`JoinDnsRecord` (decisions §17): `ChangeResourceRecordSets` takes only a **hosted-zone** ARN as its
resource, and this zone serves other production sites, so the two request-level condition keys are
what confine the instance — the least-trusted component in the system — to the single record it
owns. `ForAllValues:` is required, because a change batch is a *set*: without it, a batch carrying
`play.dst.ty.ler.dev` **plus** `dst.ty.ler.dev` would be allowed. The name is the **normalized**
form — lowercase, no trailing dot — and getting that wrong fails closed at runtime with
`AccessDenied`, not at deploy time. The reaper role carries the identical statement (§4.2's IAM);
the API Lambda carries none. The `kms:Decrypt` wildcard is the standard way to reach
the AWS-managed `aws/ssm` key (an alias ARN is not a valid IAM `Resource` and the key id is not
knowable at synth); the `ViaService` condition confines it to SSM in us-west-2. CDK creates the
instance profile automatically from `role` on the launch template.

### 3.6 Launch template

```ts
// Placeholder names match the @dst/shared constant names one-for-one (docs/game-server.md §3).
// Both files come from props.userDataPath (§1.1): the script itself, and node.env beside it.
const node = readNodeEnv(path.join(path.dirname(props.userDataPath), 'node.env'));
const userData = ec2.UserData.custom(
  fs.readFileSync(props.userDataPath, 'utf8')
    .replaceAll('__DATA_BUCKET__', DATA_BUCKET).replaceAll('__GAME_REGION__', GAME_REGION)
    .replaceAll('__TABLE_NAME__', TABLE_NAME).replaceAll('__CONTROL_REGION__', CONTROL_REGION)
    .replaceAll('__NODE_VERSION__', node.version).replaceAll('__NODE_SHA256__', node.sha256));

const lt = new ec2.LaunchTemplate(this, 'Game', {
  launchTemplateName: LAUNCH_TEMPLATE_NAME,                 // dst-server-manager-game
  instanceType: new ec2.InstanceType(INSTANCE_TYPE),        // 'c6i.large' from @dst/shared
  machineImage: ec2.MachineImage.fromSsmParameter(
    '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
    { os: ec2.OperatingSystemType.LINUX }),
  blockDevices: [{ deviceName: '/dev/sda1',                 // Canonical Ubuntu root device
    volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true, deleteOnTermination: true }) }],
  role: instanceRole, securityGroup: sg,
  requireImdsv2: true, httpPutResponseHopLimit: 1, instanceMetadataTags: true,
  instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
  detailedMonitoring: false, userData,
});
cdk.Tags.of(lt).add('role', 'game');
cdk.Tags.of(lt).add('Name', 'dst-game');
// decisions §16.16: the template carries project + role + Name; RunInstances repeats all three
// and adds sessionId (docs/control-plane.md §4). The template holds no sessionId tag.
```

- **`assets/node.env` format** (decisions §16.38 — written by `packages/supervisor`
  (`docs/game-server.md` §3) and parsed here, so it is pinned in both places, verbatim):

  > `assets/node.env` is exactly two `KEY=value` lines, no quotes, no `export`, no comments:
  > `NODE_VERSION=v22.x.y` and `NODE_SHA256=<64 lowercase hex>`. `readNodeEnv` splits on the first
  > `=` per line and throws if either key is missing or `NODE_SHA256` is not 64 hex characters.

  `readNodeEnv(p)` returns `{ version, sha256 }`; it reads the file from the directory of
  `props.userDataPath`, ignores trailing whitespace and a trailing newline, accepts the two keys in
  either order, and throws on an unknown key, a duplicate key, a missing key, or a `NODE_SHA256`
  that does not match `/^[0-9a-f]{64}$/`. `version` keeps its leading `v`, because user-data
  interpolates it into both `node-$NODE_VERSION-linux-x64.tar.xz` and the
  `https://nodejs.org/dist/$NODE_VERSION/` path.
- **AMI**: `fromSsmParameter` emits `resolve:ssm:…`, so CloudFormation resolves the current Canonical
  AMI at **deploy** time — zero AMI maintenance; a Canonical refresh changes the template on the
  next deploy, which is intended.
- **`instanceMetadataTags: true`** lets the supervisor read its own `sessionId` from IMDS instead of
  needing `ec2:DescribeTags` (which has no resource-level scoping). Confirm the read path with
  `docs/game-server.md` §8.
- **Public IP**: the template deliberately has **no `NetworkInterfaces` block**. A launch template
  can force `AssociatePublicIpAddress` only inside a network-interface spec, and once it has one, a
  `RunInstances` request may no longer pass a top-level `SubnetId` — which the API needs, since it
  picks any default public subnet at launch (decisions.md §5). So the template keeps top-level
  `SecurityGroupIds` and the public IPv4 comes from the default subnet's `MapPublicIpOnLaunch=true`.
  Verify that once before first launch (§9) and never edit the default subnets. (Setting both
  top-level `SecurityGroupIds` and `NetworkInterfaces[0].Groups` is rejected by CloudFormation —
  another reason to keep interfaces out.)
- **Versions**: any change to the template data (user-data text, AMI id, instance type, tags, block
  device) creates a **new launch template version** on deploy. The API always launches with
  `LaunchTemplate: { LaunchTemplateName: 'dst-server-manager-game', Version: '$Latest' }` — never a
  pinned number and never `$Default`, since CloudFormation's handling of the default-version pointer
  has historically lagged the newest version. `$Latest` always reflects the last deploy.

### 3.7 Session digest Lambda and its S3 trigger

The recap's digest (`docs/research/map-inventory-recap.md` §1, `packages/recap`) runs **here**, in
us-west-2 beside the bucket, and **never on the stop path**: the supervisor uploads a session's
files, the upload of `manifest.json` fires this Lambda, and the Lambda reads the saves before and
after the session plus its logs and writes `sessions/<worldId>/<sessionId>/digest/*`. It can fail,
be redeployed or be re-run over old sessions without touching a live world.

```ts
const digestLogs = new logs.LogGroup(this, 'DigestLogs', {
  logGroupName: '/aws/lambda/dst-server-manager-digest',     // DIGEST_FUNCTION_NAME
  retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });
const digest = new lambda.Function(this, 'Digest', {
  functionName: DIGEST_FUNCTION_NAME,
  code: lambda.Code.fromAsset(props.digestBundlePath),       // packages/recap/dist/lambda
  handler: 'digest.handler',
  runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
  memorySize: 1536, timeout: cdk.Duration.minutes(5), logGroup: digestLogs,
  retryAttempts: 1,
  environment: { APP_ENV: 'prod', NODE_OPTIONS: '--enable-source-maps' },
});
data.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(digest),
  { prefix: SESSIONS_PREFIX, suffix: 'manifest.json' });     // 'sessions/', 'manifest.json'
```

- **Bundle.** Same rule as the API (decisions §16.29, §4.2): `Code.fromAsset` of a directory
  `@dst/recap`'s own esbuild script already produced — `digest.js` (CommonJS, exports `handler`),
  `glue.wasm` (the Lua VM) and a `package.json` of `{"type":"commonjs"}`. Nothing is bundled in
  CDK. The root `pnpm build` builds `@dst/recap` immediately before `@dst/infra`.
- **1536 MB.** The handler parses two ~4 MB Lua saves in a WASM Lua VM, ~160 MB RSS each, and
  Lambda allocates CPU in proportion to memory, so the headroom is also speed.
- **5 minutes.** Parsing takes ~5-10 s; the Anthropic call has its own 90 s timeout; the rest is
  S3 I/O. Five minutes is generous on purpose — it is billed by actual duration, not the limit.
- **`retryAttempts: 1`.** S3 invokes Lambda **asynchronously**, and Lambda's default is two retries
  of a failed async invocation; every retry repeats the LLM call and bills it again. One retry
  covers a transient failure. It renders as an `AWS::Lambda::EventInvokeConfig` with
  `MaximumRetryAttempts: 1` (test 22).
- **Not in a VPC.** It needs egress to `api.anthropic.com`. A Lambda outside a VPC has internet
  egress for free; one inside the default VPC would need a NAT gateway, which this project never
  has (CLAUDE.md, scale to zero). Test 21 asserts there is no `VpcConfig`.
- **No reserved concurrency, on purpose.** The account hosts other production sites and reserved
  concurrency is carved out of the account-wide pool: reserving any shrinks what every other
  function in the region may use, and a deploy fails outright if it would take the unreserved pool
  below the account minimum. It is not needed either: one world runs at a time and each session
  uploads one `manifest.json`, so concurrency is ~1 except during a deliberate backfill.
- **`APP_ENV: 'prod'`** is the only env discriminator, as for the API (§4.2). Bucket, table,
  regions and the parameter name are `@dst/shared` constants, not env vars.
- **Tags.** The app-level `project=dst-server-manager` aspect tags the function, its explicit log
  group and its role (test 21); an implicit log group would be untagged and never expire (§1.2).
- **Cost.** ~1.5 GB × ~15 s ≈ 23 GB-s per session, well inside the Lambda free tier and ~$0.0003
  beyond it; logs are a few KB. The Anthropic call is billed separately by Anthropic.

**Digest IAM** — one `addToRolePolicy` per row, exactly (tests 23-24), plus the AWS-managed
`AWSLambdaBasicExecutionRole` CDK attaches for logs:

| Sid | Actions | Resources / conditions |
|---|---|---|
| `ReadSaveVersions` | `s3:GetObject`, `s3:GetObjectVersion` | `<data>/worlds/*` — the `preStartVersionId` and `postStopVersionId` versions named in the manifest |
| `ReadSessions` | `s3:GetObject` | `<data>/sessions/*` — the manifest, the logs, and earlier sessions' digests for continuity |
| `WriteDigest` | `s3:PutObject` | `<data>/sessions/*/digest/*` **only** |
| `ListSessions` | `s3:ListBucket` | `<data>` + `StringLike { "s3:prefix": ["sessions/*"] }` — earlier sessions of the same world |
| `ReadAnthropicKey` | `ssm:GetParameter` | `arn:aws:ssm:us-west-2:063257577013:parameter/dst/anthropic-api-key` (`PARAM_ANTHROPIC_API_KEY`) |
| `DecryptAnthropicKey` | `kms:Decrypt` | `arn:aws:kms:us-west-2:063257577013:key/*` + `StringEquals { "kms:ViaService": "ssm.us-west-2.amazonaws.com" }` |
| `ReadNote` | `dynamodb:GetItem` | `arn:aws:dynamodb:us-east-1:063257577013:table/dst-server-manager` + `ForAllValues:StringEquals { "dynamodb:LeadingKeys": ["NOTE"] }` |

What it deliberately lacks: **no `s3:Delete*`** anywhere; **no write outside
`sessions/*/digest/*`** — it can never overwrite a save, a log or a manifest, and it can never
write `worlds/`; **no `seed/` or `inflight/` access at all**; no `s3:ListBucketVersions` (the
version ids arrive in the manifest); no `dynamodb:` write, and `LeadingKeys` confines its one read
to the `pk=NOTE` partition (`sk = <worldId>`), so it cannot read the state item, the world registry
or anything else in the table; no other SSM parameter. Cross-region DynamoDB and same-region SSM by
ARN need no other plumbing (§5). `/dst/anthropic-api-key` is **human-managed and optional**, like
`/dst/klei-token` (§8): never a CDK resource, and when it is absent the digest still writes the
deterministic recap and records the LLM summary as unavailable (that is handler code, not IAM).

**The trigger, and how it interacts with the existing bucket.** CDK renders
`addEventNotification` as four resources, quoted from the synthesized template:

```jsonc
"DataNotifications52F6216C": { "Type": "Custom::S3BucketNotifications",
  "Properties": { "ServiceToken": { "Fn::GetAtt": ["BucketNotificationsHandler050a…", "Arn"] },
    "BucketName": { "Ref": "Data666C94C7" },
    "NotificationConfiguration": { "LambdaFunctionConfigurations": [{
      "Events": ["s3:ObjectCreated:*"],
      "Filter": { "Key": { "FilterRules": [ { "Name": "suffix", "Value": "manifest.json" },
                                            { "Name": "prefix", "Value": "sessions/" } ] } },
      "LambdaFunctionArn": { "Fn::GetAtt": ["Digest81A2F27A", "Arn"] } }] },
    "Managed": true, "SkipDestinationValidation": false },
  "DependsOn": ["DataAllowBucketNotificationsToDstGameDigest…", "DataNotificationsHandlerPolicy…",
                "DataPolicyB80589C3"] },
"DataNotificationsHandlerPolicy9C041FF0": { "Type": "AWS::IAM::Policy", "Properties": {
  "PolicyDocument": { "Statement": [{ "Action": "s3:PutBucketNotification", "Effect": "Allow",
    "Resource": { "Fn::GetAtt": ["Data666C94C7", "Arn"] } }] } } },
"DataAllowBucketNotificationsToDstGameDigest773156B95BDFC108": { "Type": "AWS::Lambda::Permission",
  "Properties": { "Action": "lambda:InvokeFunction", "Principal": "s3.amazonaws.com",
    "FunctionName": { "Fn::GetAtt": ["Digest81A2F27A", "Arn"] },
    "SourceAccount": "063257577013", "SourceArn": { "Fn::GetAtt": ["Data666C94C7", "Arn"] } } },
"BucketNotificationsHandler050a0587b7544547bf325f094a3db8347ECC3691": {
  "Type": "AWS::Lambda::Function", "Properties": { "Runtime": "python3.13", "Timeout": 300,
    "Handler": "index.handler", "Code": { "ZipFile": "<inline, CDK-owned>" } } }
```

- **It is plumbing, like the `BucketDeployment` handler.** The bucket's native
  `NotificationConfiguration` property would make the bucket depend on the Lambda permission, whose
  `SourceArn` depends on the bucket — a cycle — so CDK instead uses a custom resource whose Python
  handler calls `PutBucketNotificationConfiguration` after both exist. It runs only when that
  resource is created, updated (its properties change) or deleted — not on every deploy, and never
  at runtime. The bucket resource itself is unchanged by this feature.
- **It is a full replace.** `Managed: true` (this stack owns the bucket) makes the handler write
  the configuration above as the bucket's **entire** notification configuration, and `{}` when the
  resource is deleted. That is correct because the data bucket has no other notification — no SNS,
  SQS, EventBridge or other Lambda — and nothing outside this stack may ever add one: a hand-added
  notification would be silently erased by the next deploy that touches this resource. If one is
  ever needed, add it through `addEventNotification` here. §9 checks the configuration is empty
  **before** the first deploy of this change.
- **It deletes no object and needs no delete permission.** The handler role holds exactly one
  statement, `s3:PutBucketNotification` on the bucket ARN (test 26), plus
  `AWSLambdaBasicExecutionRole`. `PutBucketNotification` is a bucket-configuration call, so the
  `DenyDeleteOutsideScratchPrefixes` bucket policy (§3.1), which denies only
  `s3:DeleteObject`/`s3:DeleteObjectVersion`, neither blocks it nor is weakened by it; the TLS deny
  does not apply because boto3 uses HTTPS. Test 26 also asserts that across the whole stack only
  the `BucketDeployment` role (the `runtime/` prune) has any `s3:Delete*` — the digest role, the
  handler role and the instance role have none.
- **The invoke permission** is scoped by `SourceAccount` **and** `SourceArn`, so only this bucket
  in this account can invoke the digest through S3 (test 26). `SkipDestinationValidation: false`
  makes S3 validate, during `PutBucketNotificationConfiguration`, that it may invoke the Lambda —
  which is why the permission is a `DependsOn` of the custom resource.
- **Ordering.** The supervisor uploads `manifest.json` **last**, after every log file
  (`packages/supervisor/src/tasks/logsUpload.ts`), so the logs exist when the Lambda fires; and the
  supervisor never waits for it — the digest is off the stop path entirely.
- **No self-trigger.** The digest writes only under `sessions/<w>/<s>/digest/` (JSON and
  Markdown); none of those keys ends in `manifest.json`, so its writes never match the suffix
  filter. Never name a digest output `manifest.json`.
- **`sessions/test-*` fires it too — intended.** A lifecycle-test session uploads a manifest under
  `sessions/test-…/`, which matches the filter, so the lifecycle test exercises the real trigger
  end to end, and phase 4's leak scan (every `sessions/test-*` object) now covers the digest's own
  output too. Its files land under `sessions/test-*`, which the bucket policy lets the test delete
  (§3.1). **But the digest is asynchronous and the test's teardown is not aware of it:** a digest
  that finishes (or is retried) after teardown has deleted `sessions/test-*` would leave a
  `digest/` object behind and fail clean-account check 12, and one that starts after teardown has
  deleted `worlds/test-*` fails to read its save versions (one retry, then gives up). The teardown
  must therefore wait for each test session's digest (its `digest/recap.json`, or a `digest_done`
  log line) before purging, with a bound of the function timeout — `scripts/lifecycle-test.ts`.
- **Event delivery is at-least-once** and asynchronous: S3 may, rarely, deliver the same event
  twice. A digest re-run over the same session is idempotent — it overwrites the same
  `digest/` keys, and versioning keeps the previous bytes.
- **The handler's log group is implicit** (`/aws/lambda/DstGame-BucketNotificationsHandler…`,
  created on its first run, untagged, never-expiring). It is a few lines per deploy that touches
  the notification; it is on the clean-account check's allowlist in case it is ever tagged.

## 4. `DstWeb` (us-east-1)

### 4.1 DynamoDB

```ts
const table = new dynamodb.TableV2(this, 'Table', { tableName: TABLE_NAME,
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billing: dynamodb.Billing.onDemand(), removalPolicy: cdk.RemovalPolicy.RETAIN });
```

`TableV2` synthesises `AWS::DynamoDB::GlobalTable` (one replica) — assertions must use that type.
No GSIs, no streams, no PITR (not in decisions.md §14's cost table).

### 4.2 Lambdas

```ts
const apiLogs = new logs.LogGroup(this, 'ApiLogs', {
  logGroupName: '/aws/lambda/dst-server-manager-api',
  retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

const apiCode = lambda.Code.fromAsset(props.apiBundlePath);   // packages/api/dist/lambda

const api = new lambda.Function(this, 'Api', {
  functionName: 'dst-server-manager-api',
  code: apiCode, handler: 'api.handler',
  runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
  memorySize: 512, timeout: cdk.Duration.seconds(15), logGroup: apiLogs,
  environment: { APP_ENV: 'prod', PUBLIC_ORIGIN: PUBLIC_ORIGIN_PROD,   // @dst/shared
    NODE_OPTIONS: '--enable-source-maps' },
});
```

The reaper is the same shape: `functionName: 'dst-server-manager-reaper'`, the **same** `apiCode`
asset with `handler: 'reaper.handler'`, 256 MB, 60 s timeout, its own log group, env
`APP_ENV: 'prod'` and `NODE_OPTIONS` — **no** `PUBLIC_ORIGIN`. ARM64 + Node 22 for both
(decisions §16.18).

**One bundler, and what is tested is what ships** (decisions §16.29). `@dst/api`'s esbuild script
emits CommonJS `packages/api/dist/lambda/api.js` and `reaper.js`, each exporting `handler`
(`docs/control-plane.md` §5.2, `docs/testing.md` §1); `Code.fromAsset` uploads that directory
unchanged. **No `NodejsFunction`, no `bundling` prop, no esbuild and no Docker anywhere inside
CDK** — so `cdk synth` and the assertion tests never invoke a bundler, never need Docker, and the
`DST_LOCAL_ONLY` / test-secret greps of `docs/testing.md` §3 cover exactly the bytes that deploy,
in both `packages/api/dist/lambda/` and `packages/infra/cdk.out/`.

**Only `APP_ENV` and `PUBLIC_ORIGIN` are env vars.** `APP_ENV` is the one env discriminator
(decisions §16.1, `docs/auth.md` §0); the table name, bucket names, regions, launch-template name,
instance type, project tag and the four SSM parameter names are `@dst/shared` constants imported by
the handler, not environment configuration (`docs/control-plane.md` §1.1) — one definition, no
drift, nothing to keep in sync across a deploy. The two handler names correspond one-for-one to the
esbuild entry points in `docs/control-plane.md` §5.2 and §6.

The esbuild script bundles `@aws-sdk/*` into the artifact (no `--external`), so the SDK version is
deterministic and the zips are ~1-2 MB. The deprecated `logRetention` prop is not used: explicit log
groups avoid its custom resource and get tagged by the app aspect.

**IAM for both functions mirrors decisions.md §6-§7/§16.17 and is specified statement-by-statement
in `docs/control-plane.md` §7** — implement exactly that list. Shape only, for orientation: the API
gets `dynamodb:GetItem`/`UpdateItem`/`Query` on the table ARN (no `PutItem`, no `Scan`);
`ec2:RunInstances`, `ec2:CreateTags` **conditioned on `ec2:CreateAction = RunInstances`** (tag on
create, never re-tag), `ec2:DescribeInstances` / `DescribeSubnets` / `DescribeVpcs`, plus
`iam:PassRole` on the instance role; `ssm:GetParameter` on `/dst/users` and `/dst/session-secret`
(us-east-1) and `/dst/cluster-password` (us-west-2), each with a `kms:Decrypt` statement conditioned
on `kms:ViaService = ssm.<region>.amazonaws.com` — a cross-region SSM read is normal and needs no
other plumbing. The reaper gets DynamoDB access, `ec2:DescribeInstances`, and
`ec2:TerminateInstances` **conditioned on `ec2:ResourceTag/project = dst-server-manager`**.
**The reaper gets no S3 access at all.** The API got none either (decisions §16.17) until the
session recap; it now has exactly two **read-only** statements on the data bucket, to serve
digests, and nothing else in S3 — no save, seed, log or manifest, no write, no delete, no versions:

| Sid | Actions | Resources / conditions |
|---|---|---|
| `ReadDigests` | `s3:GetObject` | `arn:aws:s3:::dst-server-manager-data-063257577013/sessions/*/digest/*` |
| `ListSessions` | `s3:ListBucket` | `arn:aws:s3:::dst-server-manager-data-063257577013` + `StringLike { "s3:prefix": ["sessions/*"] }` |

`ListSessions` is what lets it find a world's newest session prefixes (`sessions/<worldId>/`,
delimiter `/`; `<sessionId>` sorts chronologically). The bucket is in us-west-2 and the API in
us-east-1: a cross-region S3 read by ARN needs no other plumbing, and the bucket name still comes
from `@dst/shared`, not an env var. Test 28 pins both statements; test 17 asserts the API has no
other `s3:` statement and the reaper none at all. **A missing digest may read as 403, not 404:** S3
returns `NoSuchKey` for an absent key only to a caller allowed to list the bucket, and whether a
`ListBucket` grant conditioned on `s3:prefix` counts for a `GetObject` (which carries no
`s3:prefix`) is not documented — so code must treat `AccessDenied` on a `digest/` key exactly like
`NoSuchKey` (not yet written), never as an outage. The same holds for the digest role (§3.7).

### 4.3 Function URL, CloudFront, OAC

Copied from the verified spike `docs/spikes/cloudfront-oac-lambda-url.md`:

```ts
const fnUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }); // never NONE
const apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl);

const site = new s3.Bucket(this, 'Site', { bucketName: SITE_BUCKET,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true, removalPolicy: cdk.RemovalPolicy.RETAIN });   // no autoDeleteObjects anywhere

const dist = new cloudfront.Distribution(this, 'Dist', {
  comment: 'dst-server-manager', domainNames: ['dst.ty.ler.dev'], certificate: cert,
  defaultRootObject: 'index.html', enableIpv6: true,              // required for the AAAA alias
  httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
  defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(site),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    responseHeadersPolicy: securityHeaders },
  additionalBehaviors: { '/api/*': { origin: apiOrigin,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS } },
});

// REQUIRED (AWS "dual auth", Oct 2025). withOriginAccessControl() grants only
// lambda:InvokeFunctionUrl; without this EVERY request is 403 AccessDeniedException.
api.addPermission('OacInvokeFunction', {
  principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
  action: 'lambda:InvokeFunction', sourceArn: dist.distributionArn });
```

- `ALL_VIEWER_EXCEPT_HOST_HEADER` is **mandatory**: forwarding the viewer `Host` contradicts the
  host CloudFront signs and breaks sigv4. Never `ALL_VIEWER`.
- The Lambda therefore cannot see `dst.ty.ler.dev`; the origin comes from `PUBLIC_ORIGIN` (§4.2).
  The spike's optional viewer-host `customHeaders` trick is not needed.
- **Circular dependency**: create the permission *after* the distribution, referencing
  `dist.distributionArn`. The chain permission → distribution → function URL → function is acyclic.
  Never make the distribution depend on the permission. If CDK ever reports a cycle, format the ARN
  from `dist.distributionId` via `cdk.Arn.format` — same resource, one fewer implicit edge.
- **No `errorResponses`.** The SPA has no router (decisions.md §4) so nothing needs a 403/404 rewrite
  to `index.html` — and custom error responses apply to *every* behaviour, which would turn the
  API's and OAC's diagnostic 403s into HTML 200s.
- Diagnostics: `AccessDeniedException` = permissions (this section); `InvalidSignatureException` =
  missing/incorrect `x-amz-content-sha256` (only POSTs with a body; all v1 mutations are bodyless).

```ts
const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
  responseHeadersPolicyName: 'dst-server-manager-security',
  securityHeadersBehavior: {
    contentSecurityPolicy: { contentSecurityPolicy: SPA_CSP, override: true }, // @dst/shared
    strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365),
      includeSubdomains: true, override: true },
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
    referrerPolicy: { override: true,
      referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER } },
});
```

The exact CSP is specified in `docs/auth.md` §8.3 and exported from `@dst/shared` as `SPA_CSP`;
import it, never duplicate the string here.
Every value here is dictated by `docs/auth.md` §8.3 and must match it byte for byte:
`Referrer-Policy: no-referrer` (not `strict-origin-when-cross-origin`) and
`Strict-Transport-Security: max-age=31536000; includeSubDomains`, the same pair the API sets on its
own responses (§8.2 there). `includeSubdomains` is safe: HSTS with it covers subdomains of
`dst.ty.ler.dev`, not siblings under `ty.ler.dev`. Attach the policy to the **default behaviour
only** — the API sets its own headers, including `Cache-Control: no-store`.

### 4.4 Certificate and DNS

```ts
const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
  hostedZoneId: 'Z038502736IM0QLQT7VFN', zoneName: 'ty.ler.dev' });
const cert = new acm.Certificate(this, 'Cert', { domainName: 'dst.ty.ler.dev',
  validation: acm.CertificateValidation.fromDns(zone) });
const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(dist));
new route53.ARecord(this, 'ARecord',       { zone, recordName: 'dst.ty.ler.dev', target });
new route53.AaaaRecord(this, 'AaaaRecord', { zone, recordName: 'dst.ty.ler.dev', target });
```

**No `new route53.HostedZone(...)` anywhere in this repo** — the zone serves other production sites.
The stack owns exactly **two** `AWS::Route53::RecordSet` resources: the `A` and `AAAA` aliases for
`dst.ty.ler.dev`.

**Plus exactly one record this repo owns but CloudFormation does not**: `play.dst.ty.ler.dev`, an
`A` record with TTL 60, written at **runtime** by the supervisor (to the instance's public IP, at
boot) and by the supervisor and reaper (to the `192.0.2.1` sink, at stop) — decisions §17. It is
deliberately not a CDK resource, for the same reason the four human-managed SSM parameters are not:
a deploy that re-materialized it would reset a live session's record, and it would turn the
"exactly two record sets" assertion into a moving number. In the zone, therefore: 2 CloudFormation
record sets + 1 runtime record + the ACM validation CNAME while validation is in flight. The ACM validation CNAME is **not** a CloudFormation record — `fromDns(zone)`
passes `DomainValidationOptions.HostedZoneId` to the certificate resource and **ACM writes and
removes that CNAME itself** through the hosted-zone id (decisions §16.31). So the template has two
record sets, and the zone temporarily holds a third record that no stack resource owns. Record
constructs are scoped to the exact name/type they declare, so nothing else is read or modified, and
on stack deletion CloudFormation removes only its two. The certificate must be in us-east-1 for
CloudFront; `DstWeb` already is.

### 4.5 Site deployment

```ts
new s3deploy.BucketDeployment(this, 'SiteAssets', {
  sources: [s3deploy.Source.asset(props.webDistPath, { exclude: ['index.html'] })],
  destinationBucket: site, prune: false,
  cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')] });

new s3deploy.BucketDeployment(this, 'SiteIndex', {
  sources: [s3deploy.Source.asset(props.webDistPath, { exclude: ['*', '!index.html'] })],
  destinationBucket: site, prune: false,
  cacheControl: [s3deploy.CacheControl.fromString('no-cache, no-store, must-revalidate')],
  distribution: dist, distributionPaths: ['/', '/index.html'] });
```

`prune: false` on **both** is required: two deployments share one bucket with no
`destinationKeyPrefix`, so a pruning deployment would delete the other's files every deploy. Cost:
superseded hashed assets accumulate (a few hundred KB, immutable, harmless — `aws s3 rm` by hand if
it ever matters). Only the index deployment invalidates, and only two paths, because hashed assets
are immutable by construction.

### 4.6 Reaper schedule

```ts
new events.Rule(this, 'ReaperSchedule', { ruleName: 'dst-server-manager-reaper',
  schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
  targets: [new eventTargets.LambdaFunction(reaper)] });   // no `event` override
```

The handler's optional `now` override (decisions.md §7) is never set here — it exists only for
`scripts/lifecycle-test.ts`, which invokes the function directly with IAM credentials.

### 4.7 Budget and SNS

```ts
const topic = new sns.Topic(this, 'BudgetTopic', { topicName: 'dst-server-manager-budget',
  displayName: 'dst-server-manager budget alerts' });
topic.addToResourcePolicy(new iam.PolicyStatement({ sid: 'AllowBudgetsPublish',
  effect: iam.Effect.ALLOW, principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
  actions: ['SNS:Publish'], resources: [topic.topicArn],
  conditions: { StringEquals: { 'aws:SourceAccount': ACCOUNT_ID },
                ArnLike: { 'aws:SourceArn': `arn:aws:budgets::${ACCOUNT_ID}:budget/*` } } }));

const note = (notificationType: string, threshold: number) => ({
  notification: { notificationType, comparisonOperator: 'GREATER_THAN', threshold,
                  thresholdType: 'PERCENTAGE' },
  subscribers: [{ subscriptionType: 'SNS', address: topic.topicArn }] });

if (props.budgetEnabled) new budgets.CfnBudget(this, 'Monthly', {
  budget: { budgetName: 'dst-server-manager-monthly', budgetType: 'COST', timeUnit: 'MONTHLY',
    budgetLimit: { amount: 5, unit: 'USD' },
    costFilters: { TagKeyValue: ['user:project$dst-server-manager'] } },
  notificationsWithSubscribers: [note('ACTUAL', 50), note('ACTUAL', 100), note('FORECASTED', 100)],
});
```

Budgets is global with its API in us-east-1 — `DstWeb` already is. No L2 exists; `CfnBudget` is
correct. **The email subscription is not a CDK resource** (it would put an address in a public repo,
and a CloudFormation-managed email subscription stays `PendingConfirmation` until clicked). One CLI
command, once, after `DstWeb` exists — never echo or log the address:

```bash
AWS_PROFILE=admin aws sns subscribe --region us-east-1 \
  --topic-arn arn:aws:sns:us-east-1:063257577013:dst-server-manager-budget \
  --protocol email --notification-endpoint "$(git config user.email)"
```

**Done:** the subscription exists and Tyler clicked the confirmation link, so
`list-subscriptions-by-topic` (§9) shows a real ARN rather than `PendingConfirmation`. Re-run the
command only if the address changes; it is idempotent per endpoint.

### 4.8 Cost-allocation tag activation

`user:project` only works as a budget filter once the `project` cost-allocation tag is **activated**,
and the key only becomes *activatable* after it appears in billing data — up to 24 h after the first
tagged resource, then up to another 24-48 h before it reaches Cost Explorer and budget filtering.

```bash
AWS_PROFILE=admin aws ce list-cost-allocation-tags --region us-east-1 --tag-keys project \
  --query 'CostAllocationTags[*].[TagKey,Type,Status]' --output table
AWS_PROFILE=admin aws ce update-cost-allocation-tags-status --region us-east-1 \
  --cost-allocation-tags-status TagKey=project,Status=Active    # idempotent
```

**Handling "not yet available":** run the list command right after the first deploy; if `project` is
absent that is expected and **not a blocker** — note it and retry later, nothing in the build
depends on it. If the `CfnBudget` deploy itself fails on an invalid cost filter (possible while the
tag is inactive), redeploy `DstWeb` with `-c budgetEnabled=false` to skip only the budget, finish
everything else, then activate the tag and redeploy without the flag — recording that as an open
item in `docs/follow-ups.md` until it is done. The topic and its policy are created either way.

**None of that was needed.** The `project` cost-allocation tag activated, `CfnBudget` accepted the
`user:project$dst-server-manager` filter, and `dst-server-manager-monthly` deployed on the first
try; `budgetEnabled` was never set to `false`. Reporting still lags 24-72 h, so a freshly activated
tag showing no cost yet is normal and not a failure.

## 5. Cross-region wiring and deploy order

No `crossRegionReferences`, no cross-region SSM export/import, no custom resources for wiring (the
two CDK plumbing custom resources of §3.2 and §3.7 act within `DstGame`). Everything the
us-east-1 Lambdas need from us-west-2 is a **deterministic name or ARN** built from `@dst/shared`
constants, under the names `docs/control-plane.md` §1.1 defines (`ACCOUNT_ID`, `CONTROL_REGION`,
`GAME_REGION`, `DATA_BUCKET`, `SITE_BUCKET`, `TABLE_NAME`, `LAUNCH_TEMPLATE_NAME`, `INSTANCE_TYPE`,
`PROJECT`, `DOMAIN_NAME`, `SPA_CSP`). Both stacks and both
Lambdas import the same constants, so there is one definition and no drift. The API picks a subnet
at launch via `DescribeSubnets` (filter `default-for-az=true`) rather than reading one from the game
stack.

`DstGame` deploys before `DstWeb` (`web.addDependency(game)`): the game stack exports nothing, but
the API is live the moment CloudFront resolves and must not reference a launch template or bucket
that does not exist. A stack dependency across environments is legal when no *reference* crosses —
it only orders deployment.

First-time local sequence (after everything is green locally):

No `cdk` command takes `--region` (decisions §16.31). `pnpm build` builds every package **first**
and runs `cdk synth` **last**, so the five asset paths exist by the time synth reads them
(`@dst/recap` is built immediately before `@dst/infra`).

```bash
cd /Users/tyler/repos/dst-server-manager
pnpm install --frozen-lockfile && pnpm build        # api bundle + supervisor bundle + web dist
# the one credentialed synth: caches cdk.context.json (§3.3) off committed fixtures only,
# so it needs no package to have been built and can run at any point
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk synth \
  -c apiBundlePath=test/fixtures/api-bundle \
  -c supervisorBundlePath=test/fixtures/supervisor-bundle \
  -c webDistPath=test/fixtures/web-dist \
  -c userDataPath=test/fixtures/user-data.sh \
  -c digestBundlePath=test/fixtures/digest-bundle
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk diff   DstCi
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk deploy DstCi   --require-approval never
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk diff   DstGame
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk deploy DstGame --require-approval never
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk diff   DstWeb
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk deploy DstWeb  --require-approval never
```

The fixture synth is the **only** command that passes `-c`: every `diff` and `deploy` uses the real
defaults, so what is deployed is always the real build output.

**Clear `packages/infra/cdk.out` before a real `diff`/`deploy`.** `cdk.out/` accumulates one asset
directory per synth and is never pruned, so the fixture synth's 53-byte stub `api.js` ends up
sitting beside the real 4 MB bundle. That does not affect what CloudFormation uploads (the template
names its own asset hash), but it silently defeats the `grep`s of `docs/testing.md` §3, which report
only that *nothing* matched. `rm -rf packages/infra/cdk.out && pnpm build` was the routine used
throughout execution. `cdk.out/` is git-ignored; only `cdk.context.json` is committed.

**Read every `cdk diff` before deploying** and confirm it touches only resources named in
decisions.md §3 — this is the guard against modifying anything else in the account. The first
`DstWeb` deploy blocks a few minutes on ACM DNS validation and ~5-15 minutes on the distribution.
Commit `cdk.context.json` afterwards.

## 6. `.github/workflows/deploy.yml`

Committed **last** (decisions.md §12), after the stacks are deployed and verified locally.
**Live:** every push to `main` now deploys `DstGame` and `DstWeb`, so `main` must always be
deployable. The first runs failed with "Not authorized to perform sts:AssumeRoleWithWebIdentity"
because the trust policy was written against the classic OIDC subject; see §2 and decisions §12.

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  id-token: write
  contents: read
concurrency:
  group: deploy-main
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: ./scripts/check-secrets.sh
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::063257577013:role/dst-server-manager-github-deploy
          aws-region: us-east-1
      - run: >
          pnpm --filter @dst/infra exec cdk deploy DstGame DstWeb
          --require-approval never --concurrency 1
```

- `corepack enable` must precede `setup-node` with `cache: pnpm` (the cache step needs `pnpm` on
  PATH). pnpm's version comes from the root `packageManager` field; no `pnpm/action-setup` needed.
- `aws-region: us-east-1` is only the STS region; each stack carries its own `env`.
- `DstCi` is **not** in the deploy list and must stay out.
- `--concurrency 1` keeps the stacks sequential, preserving DstGame → DstWeb.
- `concurrency.group` with `cancel-in-progress: false` queues overlapping pushes; never cancel a
  running CloudFormation deploy.
- Playwright is **deliberately not run here** (decisions §16.24): `pnpm e2e` needs browsers and a
  local API, and it is part of `pnpm check` locally instead. `pnpm test` is Vitest only. The four
  script names are the root scripts defined in `docs/testing.md` §1, run individually rather than
  via `pnpm check`, so the step list matches decisions §12 exactly.
- **Waiting for a run: select it by `headSha`, never `--limit 1`.** `gh run list` is ordered by start
  time, so right after a push the newest *registered* run is still the previous one; an until-loop on
  `.[0].status` exits immediately and reports the **old** run's conclusion — a green tick for a
  deploy that has not happened. The one correct shape (identical in §9 and `docs/testing.md` §7):

  ```bash
  SHA=$(git rev-parse HEAD)
  until ID=$(gh run list --workflow deploy.yml --limit 20 --json headSha,databaseId \
    -q ".[]|select(.headSha==\"$SHA\")|.databaseId" | head -1); [ -n "$ID" ]; do sleep 10; done
  until [ "$(gh run view "$ID" --json status -q .status)" = completed ]; do sleep 20; done
  gh run view "$ID" --json conclusion -q .conclusion                    # success
  # on failure: gh run view "$ID" --log-failed | tail -40
  ```

- Pin action **major** versions as shown. At implementation time check the latest major of each
  action this workflow uses and pin to it (full commit SHAs are a fine upgrade):

  ```bash
  gh api repos/actions/checkout/releases/latest                    -q .tag_name
  gh api repos/actions/setup-node/releases/latest                  -q .tag_name
  gh api repos/aws-actions/configure-aws-credentials/releases/latest -q .tag_name
  # only if the workflow ends up using it — the shape above does not:
  gh api repos/pnpm/action-setup/releases/latest                   -q .tag_name
  ```

## 7. CDK assertion tests (Vitest + `aws-cdk-lib/assertions`)

`Source.asset()` and `Code.fromAsset()` throw at synth if the path is missing, CI runs tests
**before** build (decisions.md §12), and this package's task runs in parallel with the packages that
produce those directories — so every test constructs its stacks with the committed fixture paths of
§1, e.g. `new DstGameStack(app, 'DstGame', { env, supervisorBundlePath:
path.resolve(__dirname, 'fixtures/supervisor-bundle'), userDataPath:
path.resolve(__dirname, 'fixtures/user-data.sh'), digestBundlePath:
path.resolve(__dirname, 'fixtures/digest-bundle') })` and `new DstWebStack(app, 'DstWeb', { env,
apiBundlePath: path.resolve(__dirname, 'fixtures/api-bundle'), webDistPath:
path.resolve(__dirname, 'fixtures/web-dist'), budgetEnabled: true })`. `Vpc.fromLookup` returns the
dummy VPC without context, so no test needs credentials, and nothing bundles (§4.2), so no test
needs Docker or esbuild.

**The fixtures are placeholders, and there is no save-shaped fixture anywhere here** (decisions
§16.35): `api-bundle/api.js`, `api-bundle/reaper.js` and `digest-bundle/digest.js` are one-line
stubs (`exports.handler = async () => ({ statusCode: 200 });`, linted as CommonJS by
`packages/infra/eslint.config.js`), `supervisor-bundle/install.sh` is a
`#!/bin/bash` + `exit 0` stub, `web-dist/index.html` is a minimal HTML document, and
`test/fixtures/user-data.sh` carries the same `__PLACEHOLDERS__` as the real script so the
substitution of §3.6 is exercised. `test/fixtures/node.env` sits beside it and is the §3.6 format
exactly — **two lines**, `NODE_VERSION=v22.0.0` and `NODE_SHA256=` followed by a syntactically valid
**fake** 64-lowercase-hex hash (e.g. 64 `a`s); it is a placeholder, never a real published digest,
and `readNodeEnv` must accept it. A negative test feeds `readNodeEnv` a one-line string and a
`NODE_SHA256` of 63 characters and asserts both throw. Anything that looks like a save
file — `cluster.ini`, `cluster_token.txt`, `*.zip` — is **generated at test time in a temp
directory and never committed**; `.gitignore` and `scripts/check-secrets.sh` forbid tracking it.

**DstGame** — 1. data bucket `DeletionPolicy: Retain`, versioning enabled, block-public-access all
true. 2. **no** `Custom::S3AutoDeleteObjects` resource in either stack. 3. bucket policy has a `Deny`
for exactly `s3:DeleteObject`+`s3:DeleteObjectVersion` whose `NotResource` equals the six-prefix
list (order-insensitive). 4. lifecycle: exactly three rules — `worlds/` → `{ NoncurrentDays: 30,
NewerNoncurrentVersions: 10 }`, `inflight/` → `{ 7, 3 }`, and a bucket-wide rule whose only action
is `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }`; no `seed/` or `sessions/` rule, no
top-level `ExpirationInDays` on any rule.
5. SG has exactly one ingress: `udp` 10998-10999 from `0.0.0.0/0`; assert no ingress mentions port 22
or `tcp`. 6. `LaunchTemplateData`: `MetadataOptions.HttpTokens: 'required'`,
`InstanceInitiatedShutdownBehavior: 'terminate'`, `InstanceType: 'c6i.large'`, `ImageId` starting
`resolve:ssm:/aws/service/canonical/`, 20 GB gp3 `Encrypted: true`, and `TagSpecifications` with
entries for **both** `instance` and `volume`, each carrying `project`, `role=game`, `Name=dst-game`.
7. launch template has **no** `NetworkInterfaces` and does have `SecurityGroupIds`. 8. instance role:
no statement matching `s3:Delete*`; **no statement with any `ec2:` action** (decisions §16.7);
DynamoDB resource is the us-east-1 table ARN; `ssm:GetParameter` resources are exactly the two
us-west-2 parameter ARNs and do **not** include `/dst/users`. 8bis. the instance role has exactly
**one** statement with a `route53:` action: sid `JoinDnsRecord`, action exactly
`route53:ChangeResourceRecordSets`, resource the hosted-zone ARN, and a `Condition` deep-equal to
the `ForAllValues:StringEquals` pair of §3.5 — with the record name in normalized form (assert it
does not end in `.`; that is the failure that only shows up in prod). No `route53:*` anywhere.

**DstWeb** — 9. **two** `AWS::Lambda::Permission` resources for `cloudfront.amazonaws.com` on the API
function, one `lambda:InvokeFunctionUrl` and one `lambda:InvokeFunction`, each with a `SourceArn`
referencing the distribution (the regression test for the spike's finding — the most valuable
assertion here). 10. `AWS::Lambda::Url` has `AuthType: 'AWS_IAM'`; assert no URL resource uses
`NONE`. 11. `resourceCountIs('AWS::Route53::HostedZone', 0)`. 12. `resourceCountIs('AWS::Route53::RecordSet',
2)` — one `A` and one `AAAA`, both `Name: 'dst.ty.ler.dev.'`; the ACM validation CNAME is **not** in
the template (§4.4), so asserting three would fail. Assert no record name outside `dst.ty.ler.dev`.
**This stays 2 after decisions §17**: `play.dst.ty.ler.dev` is a runtime record, and the count
staying at two is precisely what proves it.
13. `/api/*` behaviour uses the `CachingDisabled` and
`AllViewerExceptHostHeader` managed-policy ids and all seven methods; distribution has
`Aliases: ['dst.ty.ler.dev']` and **no** `CustomErrorResponses`. 14. rule `ScheduleExpression:
'rate(5 minutes)'`, `State: 'ENABLED'`, single target = reaper. 15. budget `{ Amount: 5, Unit: 'USD'
}`, `TimeUnit: 'MONTHLY'`, `CostFilters.TagKeyValue: ['user:project$dst-server-manager']`, three
notifications (ACTUAL/50, ACTUAL/100, FORECASTED/100) all with an SNS subscriber; topic policy allows
`budgets.amazonaws.com`. 16. `AWS::DynamoDB::GlobalTable` `DeletionPolicy: Retain`, on-demand.
17. both Lambdas `nodejs22.x` / `['arm64']` with handlers exactly `api.handler` and
`reaper.handler` (decisions §16.29); API env is exactly
`{ APP_ENV: 'prod', PUBLIC_ORIGIN: 'https://dst.ty.ler.dev', NODE_OPTIONS: … }` and the reaper's has
no `PUBLIC_ORIGIN`; the reaper's role has no `s3:` statement and the API's has exactly `ReadDigests`
and `ListSessions` (28). 17ter also asserts the reaper's `JoinDnsRecord` statement — same action, resource and condition as
the instance role's (§3.5) — and that the API role's policy contains no `route53:` action at all.
17bis. the site bucket has
`DeletionPolicy: Retain` and no `Custom::S3AutoDeleteObjects`; the response-headers policy carries
`Referrer-Policy: no-referrer` and `Strict-Transport-Security` with `IncludeSubdomains: true`.

**DstGame, session digest (§3.7)** — 21. `dst-server-manager-digest`: `nodejs22.x`, `['arm64']`,
`digest.handler`, 1536 MB, 300 s, **no `VpcConfig`**, no `ReservedConcurrentExecutions`, env exactly
`{ APP_ENV: 'prod', NODE_OPTIONS: '--enable-source-maps' }`, tagged `project`, and its
`LoggingConfig` names an explicit `/aws/lambda/dst-server-manager-digest` log group, 30 days,
tagged. 22. exactly one `AWS::Lambda::EventInvokeConfig`, on the digest, `MaximumRetryAttempts: 1`.
23. the digest role has exactly the seven statements of §3.7, each deep-equal on actions, resources
and conditions (the SSM resource is exactly the `/dst/anthropic-api-key` ARN). 24. the digest role
has no `s3:Delete*`, no `seed/` or `inflight/`, no `ListBucketVersions`, no DynamoDB write or
`Query`/`Scan`, no other SSM parameter, no wildcard action, and every non-read S3 action is
`s3:PutObject` on exactly `sessions/*/digest/*`; only `AWSLambdaBasicExecutionRole` is attached.
25. exactly one `Custom::S3BucketNotifications`, `Managed: true`, whose configuration is exactly
one `LambdaFunctionConfigurations` entry: `s3:ObjectCreated:*`, prefix `sessions/`, suffix
`manifest.json`, target the digest. 26. exactly one `AWS::Lambda::Permission` for
`s3.amazonaws.com`: `lambda:InvokeFunction` on the digest with `SourceAccount` and `SourceArn` = the
data bucket; the notifications handler's policy is exactly `s3:PutBucketNotification` on the bucket;
no policy in the stack except the `BucketDeployment` one has `s3:Delete*` or `s3:*`. 27. exactly
three `AWS::Lambda::Function`s in `DstGame`: the digest and the two CDK handlers.

**DstWeb, recap reads (§4.2)** — 28. the API role's `ReadDigests` is `s3:GetObject` on exactly
`arn:aws:s3:::dst-server-manager-data-063257577013/sessions/*/digest/*`, its `ListSessions` is
`s3:ListBucket` on the bucket with `StringLike { "s3:prefix": ["sessions/*"] }`, and no API `s3:`
statement mentions `Put`, `Delete`, `GetObjectVersion`, `ListBucketVersions`, `worlds/`, `seed/`,
`inflight/` or `runtime`.

**DstCi** — 18. trust policy has `sts:AssumeRoleWithWebIdentity`, a `Federated` principal ending
`oidc-provider/token.actions.githubusercontent.com`, and `StringEquals` (not `StringLike`) for both
`aud = sts.amazonaws.com` and the immutable
`sub = repo:tylerschloesser@2300885/dst-server-manager@1377732613:ref:refs/heads/main`
(decisions.md §12 explains why it is the immutable form and how to re-derive it).
19. `resourceCountIs('AWS::IAM::OIDCProvider', 0)`. 20. the inline policy has exactly one statement,
`sts:AssumeRole`, over only `cdk-hnb659fds-*` ARNs in the two regions.

`cdk-nag`'s `AwsSolutionsChecks` is optional and must not gate CI.

## 8. Human-managed resources and teardown

**Never CDK resources** (decisions.md §1), so a deploy can never overwrite them:
`/dst/klei-token` and `/dst/cluster-password` (us-west-2, SecureString), `/dst/users` (us-east-1,
String), `/dst/session-secret` (us-east-1, SecureString), and — **optional** — `/dst/anthropic-api-key`
(us-west-2, SecureString, read only by the digest, §3.7; without it the recap has no LLM summary). They appear only as ARNs in IAM policies
and names in Lambda env vars. No `ssm.StringParameter` construct anywhere in `packages/infra`, and no
`StringParameter.valueFromLookup` either — a synth-time read would cache a secret into the committed
`cdk.context.json`.

**RETAIN** applies to the data bucket, the site bucket and the table:

- `cdk destroy` leaves all three in the account, detached. A later redeploy then **fails**
  (`BucketAlreadyExists` / `ResourceInUse`) because the names are deterministic; recovery is to
  import them or delete them by hand — and deleting the data bucket destroys every save. Do not
  destroy these stacks casually.
- A **rollback** of a failed update behaves the same: retained resources are kept, not rolled back.
- Everything else (distribution, Lambdas, log groups, records, certificate, SG, launch template, IAM
  roles, budget, topic) is destroyed normally. Deleting `DstWeb` removes only its two records (§4.4);
ACM removes its own validation CNAME with the certificate.
- If teardown is ever genuinely wanted: empty and delete the site bucket, delete `DstWeb`, delete
  `DstGame`, decide separately about the data bucket and table, delete `DstCi` last, and leave
  `CDKToolkit`, the hosted zone, the OIDC provider and the human-managed SSM parameters alone.

## 9. Post-deploy verification checklist

All read-only. `export AWS_PROFILE=admin; ACC=063257577013`.

```bash
# site + API through CloudFront
curl -sI https://dst.ty.ler.dev/ | head -n 12              # 200, text/html, cache-control: no-cache
curl -sI https://dst.ty.ler.dev/ | grep -Ei 'strict-transport|content-security|x-frame|x-content'
curl -si https://dst.ty.ler.dev/api/me | head -n 5         # 401 — NOT 403 (403 => OAC/permissions)

# the function URL must NOT be reachable directly
FURL=$(aws lambda get-function-url-config --region us-east-1 \
        --function-name dst-server-manager-api --query FunctionUrl --output text)
curl -si "$FURL" | head -n 3                               # 403 {"Message":"Forbidden"}

# both CloudFront permissions on the API function
aws lambda get-policy --region us-east-1 --function-name dst-server-manager-api \
  --query Policy --output text | python3 -m json.tool | grep -E 'Invoke|SourceArn'

# game stack
aws ec2 describe-launch-template-versions --region us-west-2 \
  --launch-template-name dst-server-manager-game --versions '$Latest' \
  --query 'LaunchTemplateVersions[0].LaunchTemplateData.{Type:InstanceType,Ami:ImageId,
           Imds:MetadataOptions.HttpTokens,MdTags:MetadataOptions.InstanceMetadataTags,
           Shutdown:InstanceInitiatedShutdownBehavior,Sgs:SecurityGroupIds,
           Nics:NetworkInterfaces,TagSpecs:TagSpecifications}'
aws ec2 describe-security-groups --region us-west-2 \
  --filters Name=group-name,Values=dst-server-manager-game --query 'SecurityGroups[0].IpPermissions'
aws ec2 describe-subnets --region us-west-2 --filters Name=default-for-az,Values=true \
  --query 'Subnets[].{Id:SubnetId,Az:AvailabilityZone,Public:MapPublicIpOnLaunch}' --output table
  # every default subnet must show Public=True (§3.6)
aws s3api get-bucket-versioning --region us-west-2 --bucket dst-server-manager-data-$ACC
aws s3api get-bucket-lifecycle-configuration --region us-west-2 --bucket dst-server-manager-data-$ACC
aws s3api get-bucket-policy --region us-west-2 --bucket dst-server-manager-data-$ACC \
  --query Policy --output text | python3 -m json.tool
aws s3 ls s3://dst-server-manager-data-$ACC/runtime/ --region us-west-2

# web stack
aws dynamodb describe-table --region us-east-1 --table-name dst-server-manager \
  --query 'Table.{Billing:BillingModeSummary.BillingMode,Keys:KeySchema}'
aws events describe-rule --region us-east-1 --name dst-server-manager-reaper \
  --query '{Sched:ScheduleExpression,State:State}'
aws budgets describe-budget --region us-east-1 --account-id $ACC \
  --budget-name dst-server-manager-monthly \
  --query 'Budget.{Limit:BudgetLimit,Filters:CostFilters,Unit:TimeUnit}'
aws sns list-subscriptions-by-topic --region us-east-1 \
  --topic-arn arn:aws:sns:us-east-1:$ACC:dst-server-manager-budget \
  --query 'Subscriptions[].{Protocol:Protocol,Arn:SubscriptionArn}'
  # SubscriptionArn must not be "PendingConfirmation" — if it is, the link was not clicked
aws ce list-cost-allocation-tags --region us-east-1 --tag-keys project \
  --query 'CostAllocationTags[].[TagKey,Type,Status]' --output table

# the runtime join record (decisions §17). Between sessions it must read 192.0.2.1 — the parked
# sink — and during a session it must equal the running instance's public IP. Query the API, not a
# resolver: `dig` answers from a TTL-60 cache.
aws route53 list-resource-record-sets --hosted-zone-id Z038502736IM0QLQT7VFN \
  --start-record-name play.dst.ty.ler.dev --start-record-type A --max-items 1 \
  --query 'ResourceRecordSets[0].{Name:Name,Type:Type,TTL:TTL,Value:ResourceRecords[0].Value}'
dig +short play.dst.ty.ler.dev          # what a friend's machine actually sees, TTL 60 behind

# blast-radius check on the shared zone
aws route53 list-resource-record-sets --hosted-zone-id Z038502736IM0QLQT7VFN \
  --query 'ResourceRecordSets[?contains(Name, `dst.`)].[Name,Type]' --output table
aws route53 list-resource-record-sets --hosted-zone-id Z038502736IM0QLQT7VFN \
  --query 'length(ResourceRecordSets)'
  # compare with the count recorded BEFORE the first DstWeb deploy. The stack owns exactly TWO
  # record sets (A + AAAA, §4.4); ACM adds its validation CNAME itself and removes it after
  # validation, so the delta is 3 while validation is in flight and 2 once it settles — plus ONE
  # more, permanently, once a world has booted since decisions §17 shipped: the runtime
  # `play.dst.ty.ler.dev` A record, which no stack resource owns and no deploy removes.
```

Finally, run `cdk diff` against both deployed stacks and read it, then commit the workflow. After
the push that commits it, wait for **that commit's** run — the `headSha`-pinned loop of §6, never
`gh run list --limit 1`, which latches onto the previous completed run and reports its conclusion.

**The first CI run is not a no-op, and neither is any later one.** The supervisor bundle stages a
`VERSION` file containing the git sha (`docs/game-server.md` §11), so the `Runtime`
`BucketDeployment` asset hash changes on every commit; the Lambda code asset changes whenever
`packages/api` does. What must **not** change is everything else. Read each diff against that:

```bash
AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk diff DstGame DstWeb 2>&1 \
  | grep -E '^\[[+-~]\] AWS::(IAM|EC2|Route53|S3::BucketPolicy)' | grep -c ''   # 0
```

An IAM, security-group, launch-template, DNS, bucket-policy or lifecycle change in a diff that was
not intended is the signal to stop and look; a changed `BucketDeployment` asset and changed Lambda
code assets are expected on every push.

### 9.1 Session digest: first deploy and verification

Everything here is read-only except the deploy itself. Paste it into zsh or bash as is — `R` is an
array because zsh does not word-split `$R` (CLAUDE.md).

```bash
export AWS_PROFILE=admin
B=dst-server-manager-data-063257577013
F=dst-server-manager-digest
R=(--region us-west-2)

# BEFORE the first deploy of §3.7: the bucket must have NO notification configuration, because the
# Custom::S3BucketNotifications handler replaces the whole thing (§3.7). Expect empty output.
aws s3api get-bucket-notification-configuration "${R[@]}" --bucket "$B"
```

Deploy as always (`rm -rf packages/infra/cdk.out && pnpm build`, then the push, or a local
`cdk diff DstGame DstWeb` + `cdk deploy`). **This one deploy's diff is expected to break the §9
"0 IAM changes" rule**, and only in these ways: in `DstGame`, added `AWS::Lambda::Function` ×2
(`Digest`, `BucketNotificationsHandler…`), `AWS::IAM::Role` ×2 and `AWS::IAM::Policy` ×2 (the
digest role and its policy, the handler role and `DataNotificationsHandlerPolicy`),
`AWS::Logs::LogGroup`, `AWS::Lambda::EventInvokeConfig`, `AWS::Lambda::Permission`,
`Custom::S3BucketNotifications`; in `DstWeb`, `ApiServiceRoleDefaultPolicy` gains `ReadDigests` and
`ListSessions`. **Anything else in the diff — the bucket, its policy, the instance role, the launch
template — means stop.**

```bash
# 1. The function: nodejs22.x, arm64, 1536, 300, digest.handler, no VPC, the explicit log group.
aws lambda get-function-configuration "${R[@]}" --function-name "$F" \
  --query '{Runtime:Runtime,Arch:Architectures,Mem:MemorySize,Timeout:Timeout,Handler:Handler,
            Vpc:VpcConfig.VpcId,LogGroup:LoggingConfig.LogGroup,Env:Environment.Variables}'
# Vpc must be null (or ""); LogGroup /aws/lambda/dst-server-manager-digest.
aws lambda get-function-event-invoke-config "${R[@]}" --function-name "$F" \
  --query MaximumRetryAttempts                                      # 1
aws lambda get-function-concurrency "${R[@]}" --function-name "$F"  # {} — nothing reserved
aws logs describe-log-groups "${R[@]}" --log-group-name-prefix /aws/lambda/$F \
  --query 'logGroups[].{Name:logGroupName,Days:retentionInDays}'   # 30

# 2. The trigger: exactly one LambdaFunctionConfiguration, s3:ObjectCreated:*, prefix sessions/,
#    suffix manifest.json, pointing at the digest — and nothing else in the configuration.
aws s3api get-bucket-notification-configuration "${R[@]}" --bucket "$B"

# 3. Who may invoke it: s3.amazonaws.com, with SourceAccount 063257577013 and SourceArn the bucket.
aws lambda get-policy "${R[@]}" --function-name "$F" --query Policy --output text \
  | python3 -m json.tool

# 4. The digest role: one inline policy with the seven Sids of §3.7, and only
#    AWSLambdaBasicExecutionRole attached. IAM is global — no --region.
ROLE=$(aws lambda get-function-configuration "${R[@]}" --function-name "$F" \
  --query Role --output text); ROLE=${ROLE##*/}
aws iam list-attached-role-policies --role-name "$ROLE" --query 'AttachedPolicies[].PolicyName'
aws iam list-role-policies --role-name "$ROLE"                     # one DigestServiceRoleDefaultPolicy…
POL=$(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames[0]' --output text)
aws iam get-role-policy --role-name "$ROLE" --policy-name "$POL" \
  --query 'PolicyDocument.Statement[].{Sid:Sid,Action:Action,Resource:Resource,Condition:Condition}'

# 5. The API role's two new statements (us-east-1 function, global IAM).
AROLE=$(aws lambda get-function-configuration --region us-east-1 \
  --function-name dst-server-manager-api --query Role --output text); AROLE=${AROLE##*/}
APOL=$(aws iam list-role-policies --role-name "$AROLE" --query 'PolicyNames[0]' --output text)
aws iam get-role-policy --role-name "$AROLE" --policy-name "$APOL" \
  --query 'PolicyDocument.Statement[?Sid==`ReadDigests` || Sid==`ListSessions`]'

# 6. The optional key (human-managed; never a CDK resource). Prints the name only, never the value.
aws ssm describe-parameters "${R[@]}" --parameter-filters Key=Name,Values=/dst/anthropic-api-key \
  --query 'Parameters[].{Name:Name,Type:Type}'
```

**A real invocation.** After the next session stops (or a §9.2 re-run), the log group must show a
`digest_done` line whose JSON carries a `summary_status` field (`ok`, or why the LLM summary is
unavailable, e.g. `no_api_key`), and the session's `digest/` prefix must exist:

```bash
SINCE=$(( ($(date +%s) - 86400) * 1000 ))                           # last 24 h, in ms
aws logs filter-log-events "${R[@]}" --log-group-name /aws/lambda/$F \
  --filter-pattern '"digest_done"' --start-time "$SINCE" --query 'events[].message' --output text
aws logs filter-log-events "${R[@]}" --log-group-name /aws/lambda/$F \
  --filter-pattern '?ERROR ?"Task timed out" ?"Runtime.OutOfMemory"' --start-time "$SINCE" \
  --query 'events[].message' --output text                         # nothing
W=tylerni2026
S=$(aws s3api list-objects-v2 "${R[@]}" --bucket "$B" --prefix "sessions/$W/" --delimiter / \
  --query 'CommonPrefixes[-1].Prefix' --output text)                 # newest session prefix
aws s3 ls "s3://$B/${S}digest/" "${R[@]}"
```

`Task timed out after 300.00 seconds` means the parse or the LLM call hung; `Runtime.OutOfMemory`
means the saves outgrew 1536 MB. Neither can affect a session: the digest is off the stop path.

### 9.2 Re-run the digest for one session (or backfill)

No re-upload is needed, and nothing but the digest's own output is written: invoke the function
directly with a **synthetic S3 event** naming that session's existing `manifest.json`. The event is
only input — nothing is written to produce or send it — and the handler then does exactly what a
real upload triggers: it reads the manifest, the saves and the logs, and writes
`sessions/<w>/<s>/digest/*` (overwriting a previous digest; versioning keeps the old bytes). The
admin profile invokes it directly, so the S3 invoke permission is not involved. It is safe at any
time, even during a session: it only reads saves by version id and writes only under `digest/`.

```bash
export AWS_PROFILE=admin
B=dst-server-manager-data-063257577013
R=(--region us-west-2)
W=tylerni2026
aws s3api list-objects-v2 "${R[@]}" --bucket "$B" --prefix "sessions/$W/" --delimiter / \
  --query 'CommonPrefixes[].Prefix' --output text | tr '\t' '\n'    # oldest first
S=20260927T010203Z-abc123                                           # <- one sessionId from above

# `>|` because Tyler's zsh has noclobber; it is valid bash too.
cat >| /tmp/digest-event.json <<JSON
{"Records":[{"eventSource":"aws:s3","eventName":"ObjectCreated:Put","awsRegion":"us-west-2",
 "s3":{"bucket":{"name":"$B","arn":"arn:aws:s3:::$B"},
       "object":{"key":"sessions/$W/$S/manifest.json"}}}]}
JSON
# Synchronous, so the result prints. The CLI's default 60 s read timeout is shorter than the
# function's 300 s, hence --cli-read-timeout.
aws lambda invoke "${R[@]}" --function-name dst-server-manager-digest \
  --cli-binary-format raw-in-base64-out --cli-read-timeout 330 \
  --payload file:///tmp/digest-event.json /tmp/digest-out.json
cat /tmp/digest-out.json; echo
aws s3 ls "s3://$B/sessions/$W/$S/digest/" "${R[@]}"
```

A synchronous invoke is never retried by Lambda (the one retry of §3.7 applies to asynchronous
invokes only), so a failed re-run bills at most one LLM call. **Backfill** is the same invoke in a
loop, **oldest session first, one at a time**: each digest reads earlier sessions' digests for
continuity, so running them concurrently or out of order gives each one less context.

```bash
aws s3api list-objects-v2 "${R[@]}" --bucket "$B" --prefix "sessions/$W/" --delimiter / \
  --query 'CommonPrefixes[].Prefix' --output text | tr '\t' '\n' | while read -r P; do
  S=${P#sessions/$W/}; S=${S%/}
  printf '{"Records":[{"eventSource":"aws:s3","eventName":"ObjectCreated:Put","awsRegion":"us-west-2","s3":{"bucket":{"name":"%s","arn":"arn:aws:s3:::%s"},"object":{"key":"sessions/%s/%s/manifest.json"}}}]}' \
    "$B" "$B" "$W" "$S" >| /tmp/digest-event.json
  echo "== $S"
  aws lambda invoke "${R[@]}" --function-name dst-server-manager-digest \
    --cli-binary-format raw-in-base64-out --cli-read-timeout 330 \
    --payload file:///tmp/digest-event.json /tmp/digest-out.json </dev/null >/dev/null \
    && cat /tmp/digest-out.json; echo
done
```

(`</dev/null` keeps `aws` from reading the loop's own stdin, the list of prefixes.)

A session whose `preStartVersionId` or `postStopVersionId` has since expired under the `worlds/`
lifecycle rule (older than 30 days **and** beyond the 10 newest noncurrent versions,
`docs/storage.md` §2) can no longer be diffed; expect that invocation to report it (in its result
and in the log group) rather than write a digest. That is why a backfill of the sessions from before the recap existed has a deadline
(around 2026-10-21, `docs/research/map-inventory-recap.md` §1).
