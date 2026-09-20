# Infra: CDK stacks, DNS, CI/CD, tagging, budget

Domain doc for `packages/infra` and `.github/workflows/deploy.yml`. Source of truth is
[`decisions.md`](./decisions.md) §2, §3, §7, §10, §12, §13 — this doc elaborates, never overrides.
Siblings: `docs/storage.md` (bucket layout, lifecycle rationale, manual restore),
`docs/control-plane.md` (API/reaper behaviour **and their exact IAM statements**), `docs/auth.md`
(the CSP string, cookies), `docs/supervisor.md` (user-data, runtime bundle).

## 0. Hard constraints

- **The account `063257577013` hosts other production sites.** Nothing this project did not create
  may be created, modified or deleted: the hosted zone `ty.ler.dev`, the GitHub OIDC provider, both
  `CDKToolkit` stacks, every existing distribution/Lambda/bucket.
- **No default AWS profile, no default region.** Every CLI call passes `AWS_PROFILE=admin` *and*
  `--region`. Every stack sets `env` explicitly.
- **Bootstrap**: us-east-1 v30, us-west-2 v18. Both sufficient (min 6 to deploy, min 8 for context
  lookups). **Do not re-bootstrap** — `docs/research/cdk-version.md` §3 suggests it; decisions.md
  overrules.
- **Public repo.** No SteamIDs, emails, tokens or passwords in `packages/infra`. The account id and
  zone id are already public in decisions.md and are fine.
- No global `cdk`: everything is `pnpm --filter infra exec cdk ...`.

## 1. Package layout

```
packages/infra/
  package.json      deps aws-cdk-lib@2.270.0 constructs@10.8.1; devDeps aws-cdk@2.1142.0 tsx vitest
  cdk.json          { "app": "pnpm exec tsx bin/app.ts", "context": { ...feature flags... } }
  cdk.context.json  COMMITTED (default-VPC lookup cache, §3.3)
  bin/app.ts        App, explicit envs, Tags.of(app), deploy ordering
  lib/{ci,game,web}-stack.ts        test/{ci,game,web}-stack.test.ts
  test/fixtures/web-dist/index.html, test/fixtures/supervisor-bundle/.keep   (§7)
```

Produce `cdk.json`'s feature-flag `context` block once by running `cdk init app --language
typescript` with `aws-cdk@2.1142.0` in a scratch dir and copying it. Do not hand-write flags.

### 1.1 `bin/app.ts`

```ts
const app = new cdk.App();
const webEnv  = { account: ACCOUNT, region: WEB_REGION };   // 063257577013 / us-east-1
const gameEnv = { account: ACCOUNT, region: GAME_REGION };  // 063257577013 / us-west-2

new DstCiStack(app, 'DstCi', { env: webEnv, stackName: 'DstCi' });
const game = new DstGameStack(app, 'DstGame', { env: gameEnv, stackName: 'DstGame',
  supervisorBundlePath: app.node.tryGetContext('supervisorBundlePath')
    ?? path.resolve(__dirname, '../../supervisor/dist-bundle') });
const web = new DstWebStack(app, 'DstWeb', { env: webEnv, stackName: 'DstWeb',
  webDistPath: app.node.tryGetContext('webDistPath') ?? path.resolve(__dirname, '../../web/dist'),
  budgetEnabled: app.node.tryGetContext('budgetEnabled') !== 'false' });

web.addDependency(game);                       // ordering only; no cross-region references (§5)
cdk.Tags.of(app).add('project', PROJECT_TAG);  // 'dst-server-manager'
```

`stackName` is explicit so CloudFormation stacks are exactly `DstCi` / `DstGame` / `DstWeb`.

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

The four SSM parameters are human-managed (§8) and were tagged by hand at creation.

## 2. `DstCi` (us-east-1) — GitHub OIDC deploy role

Deployed **once, locally, with `AWS_PROFILE=admin`**; the workflow never deploys it (it has no
credentials until this role exists).

```ts
const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc',
  `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`);

const bootstrapRoles = ['deploy-role', 'file-publishing-role', 'lookup-role'].flatMap((r) =>
  [WEB_REGION, GAME_REGION].map((g) => `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-${r}-${ACCOUNT}-${g}`));

const role = new iam.Role(this, 'GithubDeployRole', {
  roleName: 'dst-server-manager-github-deploy',
  maxSessionDuration: cdk.Duration.hours(1),
  assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub':
        'repo:tylerschloesser/dst-server-manager:ref:refs/heads/main',
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
AWS_PROFILE=admin pnpm --filter infra exec cdk deploy DstCi --region us-east-1 --require-approval never
```

## 3. `DstGame` (us-west-2)

decisions.md §2's "No Lambdas" means no *application* Lambdas; the `BucketDeployment` custom
resource (§3.2) does create a CDK-managed Lambda here, which is expected plumbing.

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
    { id: 'worlds-noncurrent', prefix: 'worlds/', enabled: true,
      noncurrentVersionExpiration: cdk.Duration.days(30), noncurrentVersionsToRetain: 10 },
    { id: 'inflight-noncurrent', prefix: 'inflight/', enabled: true,
      noncurrentVersionExpiration: cdk.Duration.days(7), noncurrentVersionsToRetain: 3 },
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

`noncurrentVersionsToRetain` renders as `NewerNoncurrentVersions`. `Deny` + `NotResource` is safe
because a bucket policy is only evaluated for its own bucket. `enforceSSL` adds a second deny
statement, so assertions must not assume one statement. Lifecycle is not subject to the policy —
that is how old versions still age out. No `seed/` or `sessions/` expiration rule.

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
**synth** time, so `pnpm --filter supervisor build` must precede any synth/diff/deploy, and tests
pass a fixture path (§7).

### 3.3 Default VPC lookup

`const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });` — both regions have one.
This is a **context lookup**: run `cdk synth DstGame` once locally with `AWS_PROFILE=admin` and
**commit the generated `cdk.context.json`**, so CI synthesises with no AWS call. Without the file CI
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
| `ReadWriteSaves` | `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject` | `<data>/worlds/*`, `<data>/inflight/*` |
| `WriteSessionsAndCaches` | `s3:PutObject` | `<data>/sessions/*`, `<data>/binaries/*`, `<data>/runtime-cache/*` |
| `ListDataPrefixes` | `s3:ListBucket` | `<data>` + `StringLike { "s3:prefix": ["runtime/*","runtime-cache/*","binaries/*","worlds/*","inflight/*","sessions/*"] }` |
| `State` | `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:UpdateItem` | `arn:aws:dynamodb:us-east-1:063257577013:table/dst-server-manager` (cross-region, by ARN) |
| `Secrets` | `ssm:GetParameter` | `arn:aws:ssm:us-west-2:063257577013:parameter/dst/klei-token`, `…/parameter/dst/cluster-password` |
| `DecryptSecrets` | `kms:Decrypt` | `*` + `StringEquals { "kms:ViaService": "ssm.us-west-2.amazonaws.com" }` |

No `s3:Delete*` anywhere. **No access to `seed/`** — the seed zip is read only by
`scripts/import-world` under the admin profile. No `ec2:*` — the instance ends itself via
`shutdown -h now` + terminate-on-shutdown. The `kms:Decrypt` wildcard is the standard way to reach
the AWS-managed `aws/ssm` key (an alias ARN is not a valid IAM `Resource` and the key id is not
knowable at synth); the `ViaService` condition confines it to SSM in us-west-2. CDK creates the
instance profile automatically from `role` on the launch template.

### 3.6 Launch template

```ts
const userData = ec2.UserData.custom(
  fs.readFileSync(path.resolve(__dirname, '../../supervisor/assets/user-data.sh'), 'utf8')
    .replaceAll('__DATA_BUCKET__', DATA_BUCKET).replaceAll('__GAME_REGION__', GAME_REGION)
    .replaceAll('__TABLE_NAME__', TABLE_NAME).replaceAll('__WEB_REGION__', WEB_REGION));

const lt = new ec2.LaunchTemplate(this, 'Game', {
  launchTemplateName: LAUNCH_TEMPLATE_NAME,                 // dst-server-manager-game
  instanceType: new ec2.InstanceType(GAME_INSTANCE_TYPE),   // 'c6i.large' from packages/shared
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
```

- **AMI**: `fromSsmParameter` emits `resolve:ssm:…`, so CloudFormation resolves the current Canonical
  AMI at **deploy** time — zero AMI maintenance; a Canonical refresh changes the template on the
  next deploy, which is intended.
- **`instanceMetadataTags: true`** lets the supervisor read its own `sessionId` from IMDS instead of
  needing `ec2:DescribeTags` (which has no resource-level scoping). Confirm the read path with
  `docs/supervisor.md`.
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

const api = new nodejs.NodejsFunction(this, 'Api', {
  functionName: 'dst-server-manager-api',
  entry: path.resolve(__dirname, '../../api/src/handlers/api.ts'), handler: 'handler',
  runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
  memorySize: 512, timeout: cdk.Duration.seconds(15), logGroup: apiLogs,
  bundling: { minify: true, sourceMap: true, target: 'node22', format: nodejs.OutputFormat.CJS },
  environment: { PUBLIC_ORIGIN: 'https://dst.ty.ler.dev', DST_ENV: 'prod',
    TABLE_NAME, DATA_BUCKET, GAME_REGION, LAUNCH_TEMPLATE_NAME, GAME_INSTANCE_TYPE,
    USERS_PARAM: '/dst/users', SESSION_SECRET_PARAM: '/dst/session-secret',
    CLUSTER_PASSWORD_PARAM: '/dst/cluster-password', NODE_OPTIONS: '--enable-source-maps' },
});
```

The reaper is the same shape: `functionName: 'dst-server-manager-reaper'`, entry
`…/handlers/reaper.ts`, 256 MB, 60 s timeout, its own log group, env `TABLE_NAME`, `GAME_REGION`,
`PROJECT_TAG`, `MAX_SESSION_HOURS` — **no** `PUBLIC_ORIGIN`. ARM64 is fine and cheaper for both.
Leave `bundling.externalModules` at the CDK default so `@aws-sdk/*` is bundled (deterministic SDK
version, ~1-2 MB zips). The deprecated `logRetention` prop is not used: explicit log groups avoid
its custom resource and get tagged by the app aspect.

**IAM for both functions mirrors decisions.md §6-§7 and is specified statement-by-statement in
`docs/control-plane.md`** — implement it there. Shape only, for orientation: API gets DynamoDB item
access on the table ARN; `ec2:RunInstances` / `DescribeInstances` / `DescribeSubnets` in us-west-2
plus `iam:PassRole` on the instance role; `ssm:GetParameter` on `/dst/users`, `/dst/session-secret`
(us-east-1) and `/dst/cluster-password` (us-west-2) with matching `kms:Decrypt` + `kms:ViaService`
statements per region. Reaper gets DynamoDB access, `ec2:DescribeInstances`, and
`ec2:TerminateInstances` **conditioned on `ec2:ResourceTag/project = dst-server-manager`**. Neither
gets `s3:Delete*`.

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
    contentSecurityPolicy: { contentSecurityPolicy: CSP, override: true },  // CSP from docs/auth.md
    strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365),
      includeSubdomains: false, override: true },
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
    referrerPolicy: { override: true,
      referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN } },
});
```

The exact CSP is specified in `docs/auth.md`; import it from `packages/shared`, do not duplicate it.
Attach the policy to the **default behaviour only** — the API sets its own headers
(`Cache-Control: no-store`). `includeSubdomains: false` because HSTS would otherwise apply to
sibling hosts under `ty.ler.dev` that this project does not own.

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
The stack owns exactly three record sets: the ACM validation CNAME and the two `dst.ty.ler.dev`
aliases. Record constructs are scoped to the exact name/type they declare, so nothing else is read
or modified, and on stack deletion CloudFormation removes only those three. The certificate must be
in us-east-1 for CloudFront; `DstWeb` already is.

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
  conditions: { StringEquals: { 'aws:SourceAccount': ACCOUNT },
                ArnLike: { 'aws:SourceArn': `arn:aws:budgets::${ACCOUNT}:budget/*` } } }));

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
absent that is expected and **not a blocker** — note it and retry in a later session, nothing in the
build depends on it. If the `CfnBudget` deploy itself fails on an invalid cost filter (possible while
the tag is inactive), redeploy `DstWeb` with `-c budgetEnabled=false` to skip only the budget,
finish everything else, then activate the tag and redeploy without the flag. The topic and its
policy are created either way.

## 5. Cross-region wiring and deploy order

No `crossRegionReferences`, no cross-region SSM export/import, no custom resources. Everything the
us-east-1 Lambdas need from us-west-2 is a **deterministic name or ARN** built from `packages/shared`
constants (`ACCOUNT`, `WEB_REGION`, `GAME_REGION`, `DATA_BUCKET`, `SITE_BUCKET`, `TABLE_NAME`,
`LAUNCH_TEMPLATE_NAME`, `GAME_INSTANCE_TYPE`, `PROJECT_TAG`, `DOMAIN_NAME`). Both stacks and both
Lambdas import the same constants, so there is one definition and no drift. The API picks a subnet
at launch via `DescribeSubnets` (filter `default-for-az=true`) rather than reading one from the game
stack.

`DstGame` deploys before `DstWeb` (`web.addDependency(game)`): the game stack exports nothing, but
the API is live the moment CloudFront resolves and must not reference a launch template or bucket
that does not exist. A stack dependency across environments is legal when no *reference* crosses —
it only orders deployment.

First-time local sequence (after everything is green locally):

```bash
cd /Users/tyler/repos/dst-server-manager
pnpm install --frozen-lockfile && pnpm -r build     # supervisor bundle + web dist must exist
AWS_PROFILE=admin pnpm --filter infra exec cdk synth  DstGame --region us-west-2  # writes context
AWS_PROFILE=admin pnpm --filter infra exec cdk diff   DstCi   --region us-east-1
AWS_PROFILE=admin pnpm --filter infra exec cdk deploy DstCi   --region us-east-1 --require-approval never
AWS_PROFILE=admin pnpm --filter infra exec cdk diff   DstGame --region us-west-2
AWS_PROFILE=admin pnpm --filter infra exec cdk deploy DstGame --region us-west-2 --require-approval never
AWS_PROFILE=admin pnpm --filter infra exec cdk diff   DstWeb  --region us-east-1
AWS_PROFILE=admin pnpm --filter infra exec cdk deploy DstWeb  --region us-east-1 --require-approval never
```

**Read every `cdk diff` before deploying** and confirm it touches only resources named in
decisions.md §3 — this is the guard against modifying anything else in the account. The first
`DstWeb` deploy blocks a few minutes on ACM DNS validation and ~5-15 minutes on the distribution.
Commit `cdk.context.json` afterwards.

## 6. `.github/workflows/deploy.yml`

Committed **last** (decisions.md §12), after the stacks are deployed and verified locally.

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
      - run: pnpm -r lint
      - run: pnpm -r typecheck
      - run: pnpm -r test
      - run: pnpm -r build
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::063257577013:role/dst-server-manager-github-deploy
          aws-region: us-east-1
      - run: >
          pnpm --filter infra exec cdk deploy DstGame DstWeb
          --require-approval never --concurrency 1
```

- `corepack enable` must precede `setup-node` with `cache: pnpm` (the cache step needs `pnpm` on
  PATH). pnpm's version comes from the root `packageManager` field; no `pnpm/action-setup` needed.
- `aws-region: us-east-1` is only the STS region; each stack carries its own `env`.
- `DstCi` is **not** in the deploy list and must stay out.
- `--concurrency 1` keeps the stacks sequential, preserving DstGame → DstWeb.
- `concurrency.group` with `cancel-in-progress: false` queues overlapping pushes; never cancel a
  running CloudFormation deploy.
- Playwright is not run here (needs browsers and a local API); `pnpm -r test` is Vitest only.
- Pin action **major** versions as shown. At implementation time verify the current major of
  `aws-actions/configure-aws-credentials` (v4 as of the research pass; a newer major may exist) and
  use it; likewise `actions/checkout` and `actions/setup-node`. Full commit SHAs are a fine upgrade.

## 7. CDK assertion tests (Vitest + `aws-cdk-lib/assertions`)

`Source.asset()` throws at synth if the path is missing and CI runs tests **before** build
(decisions.md §12), so tests construct stacks with fixture paths:
`new DstGameStack(app, 'DstGame', { env, supervisorBundlePath: path.resolve(__dirname,
'fixtures/supervisor-bundle') })`. `Vpc.fromLookup` returns the dummy VPC without context, so no test
needs credentials.

**DstGame** — 1. data bucket `DeletionPolicy: Retain`, versioning enabled, block-public-access all
true. 2. **no** `Custom::S3AutoDeleteObjects` resource in either stack. 3. bucket policy has a `Deny`
for exactly `s3:DeleteObject`+`s3:DeleteObjectVersion` whose `NotResource` equals the six-prefix
list (order-insensitive). 4. lifecycle: `worlds/` → `{ NoncurrentDays: 30, NewerNoncurrentVersions:
10 }`, `inflight/` → `{ 7, 3 }`, no `seed/` or `sessions/` rule, no top-level `ExpirationInDays`.
5. SG has exactly one ingress: `udp` 10998-10999 from `0.0.0.0/0`; assert no ingress mentions port 22
or `tcp`. 6. `LaunchTemplateData`: `MetadataOptions.HttpTokens: 'required'`,
`InstanceInitiatedShutdownBehavior: 'terminate'`, `InstanceType: 'c6i.large'`, `ImageId` starting
`resolve:ssm:/aws/service/canonical/`, 20 GB gp3 `Encrypted: true`, and `TagSpecifications` with
entries for **both** `instance` and `volume`, each carrying `project`, `role=game`, `Name=dst-game`.
7. launch template has **no** `NetworkInterfaces` and does have `SecurityGroupIds`. 8. instance role:
no statement matching `s3:Delete*`; DynamoDB resource is the us-east-1 table ARN; `ssm:GetParameter`
resources are exactly the two us-west-2 parameter ARNs.

**DstWeb** — 9. **two** `AWS::Lambda::Permission` resources for `cloudfront.amazonaws.com` on the API
function, one `lambda:InvokeFunctionUrl` and one `lambda:InvokeFunction`, each with a `SourceArn`
referencing the distribution (the regression test for the spike's finding — the most valuable
assertion here). 10. `AWS::Lambda::Url` has `AuthType: 'AWS_IAM'`; assert no URL resource uses
`NONE`. 11. `resourceCountIs('AWS::Route53::HostedZone', 0)`. 12. every `AWS::Route53::RecordSet`
has `Name` `dst.ty.ler.dev.` or is the ACM validation record for that name — assert no record name
outside `dst.ty.ler.dev`. 13. `/api/*` behaviour uses the `CachingDisabled` and
`AllViewerExceptHostHeader` managed-policy ids and all seven methods; distribution has
`Aliases: ['dst.ty.ler.dev']` and **no** `CustomErrorResponses`. 14. rule `ScheduleExpression:
'rate(5 minutes)'`, `State: 'ENABLED'`, single target = reaper. 15. budget `{ Amount: 5, Unit: 'USD'
}`, `TimeUnit: 'MONTHLY'`, `CostFilters.TagKeyValue: ['user:project$dst-server-manager']`, three
notifications (ACTUAL/50, ACTUAL/100, FORECASTED/100) all with an SNS subscriber; topic policy allows
`budgets.amazonaws.com`. 16. `AWS::DynamoDB::GlobalTable` `DeletionPolicy: Retain`, on-demand.
17. both Lambdas `nodejs22.x` / `['arm64']`; API env has `PUBLIC_ORIGIN: 'https://dst.ty.ler.dev'`.

**DstCi** — 18. trust policy has `sts:AssumeRoleWithWebIdentity`, a `Federated` principal ending
`oidc-provider/token.actions.githubusercontent.com`, and `StringEquals` (not `StringLike`) for both
`aud = sts.amazonaws.com` and `sub = repo:tylerschloesser/dst-server-manager:ref:refs/heads/main`.
19. `resourceCountIs('AWS::IAM::OIDCProvider', 0)`. 20. the inline policy has exactly one statement,
`sts:AssumeRole`, over only `cdk-hnb659fds-*` ARNs in the two regions.

`cdk-nag`'s `AwsSolutionsChecks` is optional and must not gate CI.

## 8. Human-managed resources and teardown

**Never CDK resources** (decisions.md §1), so a deploy can never overwrite them:
`/dst/klei-token` and `/dst/cluster-password` (us-west-2, SecureString), `/dst/users` (us-east-1,
String), `/dst/session-secret` (us-east-1, SecureString). They appear only as ARNs in IAM policies
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
  roles, budget, topic) is destroyed normally. Deleting `DstWeb` removes only its three records.
- If teardown is ever genuinely wanted: empty and delete the site bucket, delete `DstWeb`, delete
  `DstGame`, decide separately about the data bucket and table, delete `DstCi` last, and leave
  `CDKToolkit`, the hosted zone, the OIDC provider and the four SSM parameters alone.

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
           Imds:MetadataOptions.HttpTokens,MdTags:InstanceMetadataTags,
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

# blast-radius check on the shared zone
aws route53 list-resource-record-sets --hosted-zone-id Z038502736IM0QLQT7VFN \
  --query 'ResourceRecordSets[?contains(Name, `dst.`)].[Name,Type]' --output table
aws route53 list-resource-record-sets --hosted-zone-id Z038502736IM0QLQT7VFN \
  --query 'length(ResourceRecordSets)'
  # compare with the count recorded BEFORE the first DstWeb deploy; delta must be 2 or 3
```

Finally, confirm a clean `cdk diff` against both deployed stacks, then commit the workflow; its first
run should produce the same empty diff and a no-op deploy.
