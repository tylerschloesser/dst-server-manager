# CDK version, bootstrap, OIDC, and cross-region research

Date: 2026-09-19
Account: `063257577013`. Web stack region `us-east-1` (bootstrap v30). Game stack region `us-west-2` (bootstrap v18).

---

## 1. Versions to pin

Checked live against the npm registry (`registry.npmjs.org`), not memory, on 2026-09-19:

| Package | Latest | Published |
|---|---|---|
| `aws-cdk-lib` | **2.270.0** | 2026-09-17 |
| `aws-cdk` (CLI) | **2.1142.0** | 2026-09-16 |
| `constructs` | **10.8.1** | — |

`aws-cdk-lib` and `aws-cdk` have been versioned independently since ~early 2025 (CLI numbers run far ahead, e.g. 2.1142.0 vs library 2.270.0 — these are unrelated counters, not a mismatch). `constructs` stays on the v10 line for CDK v2; there is no v11 in general use.

**Recommendation:** pin exact versions in `package.json` (no `^`/`~`) since this is a small, single-maintainer app and you want reproducible CI deploys:
- `aws-cdk-lib`: `2.270.0`
- `aws-cdk` (devDependency, CLI): `2.1142.0`
- `constructs`: `10.8.1`

Sources: [aws-cdk-lib npm](https://www.npmjs.com/package/aws-cdk-lib), [aws-cdk npm](https://www.npmjs.com/package/aws-cdk), [constructs npm](https://www.npmjs.com/package/constructs), npm registry API (`registry.npmjs.org/aws-cdk-lib`, `/aws-cdk`, `/constructs`).

---

## 2. Is bootstrap v18 in us-west-2 new enough?

**Verdict: it will WORK, not fail, for a plain stack with file assets (`NodejsFunction` via esbuild, `BucketDeployment`).** No VPC context lookup issue either (see below). But v18 is 14 template versions behind current (v32) and misses several security/robustness improvements. Recommend re-bootstrapping (see §3) — safe, not urgent-blocking.

### Why it works
`aws-cdk-lib`'s `DefaultStackSynthesizer` embeds a `CDKMetadata`/`AWS::CDK::Metadata` rule requiring a **minimum bootstrap version**, checked from source (`packages/aws-cdk-lib/core/lib/stack-synthesizers/default-synthesizer.ts`):
- `MIN_BOOTSTRAP_STACK_VERSION = 6` — baseline requirement for any deploy with the modern (v2) synthesizer.
- `MIN_LOOKUP_ROLE_BOOTSTRAP_STACK_VERSION = 8` — needed only if the app does a context lookup (e.g. `Vpc.fromLookup`) that uses the bootstrap `lookup-role`.
- `MIN_SESSION_TAGS_BOOTSTRAP_STACK_VERSION = 22` — needed only if the CLI/assume-role call passes STS session tags (ABAC-style deploys); not something `aws-actions/configure-aws-credentials` + plain `cdk deploy` does by default.

v18 ≥ 8, so both file-asset deploys and a default-VPC lookup (`Vpc.fromLookup`) will succeed. No container/image assets are used in this project, so the ECR-immutability (v13) and image-scanning (v14) template changes are irrelevant.

### Full bootstrap template version history (v18 → latest = v32)

| Ver | CDK version it shipped with | Change |
|---|---|---|
| 18 | 2.80.0 | Reverted v16 KMS changes (didn't work in all partitions) — **current us-west-2 state** |
| 19 | 2.106.1 | Reverted a v18 regression (`AccessControl` property removed then restored) |
| 20 | 2.119.0 | Added `ssm:GetParameters` to the CloudFormation deploy role |
| 21 | 2.149.0 | Added a condition to the file-publishing role |
| 22 | 2.160.0 | Added `sts:TagSession` to bootstrap IAM roles' trust policies |
| 23 | 2.161.0 | Added `cloudformation:RollbackStack` / `ContinueUpdateRollback` to deploy role (enables `cdk rollback`) |
| 24 | 2.165.0 | Noncurrent-object retention in the asset bucket lowered 365→30 days (supports `cdk gc`) |
| 25 | 2.165.0 | Asset bucket auto-deletes incomplete multipart uploads after 1 day |
| 26 | 2.1002.0 | Deletion policies added to the (legacy) KMS key resource for clean stack updates/deletes |
| 27 | 2.1003.0 | ECR resource policy grants EMR Serverless image-pull permissions |
| 28 | 2.1015.0 | Deploy role gets Stack Refactoring permissions; TagSession added to all roles |
| 29 | 2.1026.0 | AssumeRole calls that pass an `ExternalId` are now **rejected by default** unless disabled |
| 30 | 2.1034.0 | Deploy role can describe stack events (accurate CFN early-validation errors) — **current us-east-1 state** |
| 31 | 2.1116.0 | Adds `cloudformation:GetHookResult` to the Deploy Role |
| 32 | 2.1120.0 | Deploy role's many individual read permissions collapsed into `AWSCloudFormationReadOnlyAccess` managed policy — **latest** |

Source: [Bootstrap template version history — AWS CDK v2 Developer Guide](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html#bootstrap-template-history) (full table fetched directly), cross-referenced with `aws-cdk-cli` PR numbers cited there.

### What this means practically
- Your GitHub Actions deploy role assumes the bootstrap `deploy-role`/`file-publishing-role`/`lookup-role` via plain `sts:AssumeRole` (no ExternalId, no session tags) — v18 handles this fine.
- You will **not** get `cdk rollback` (needs v23) or `cdk gc` asset garbage collection (needs v24/25) or the newer `AWSCloudFormationReadOnlyAccess`-based deploy role (v32) until you re-bootstrap.
- No breaking/failure scenario exists today at v18 for your stated stack shape.

---

## 3. Re-bootstrapping us-west-2

### Check existing parameters first
```
AWS_PROFILE=admin aws cloudformation describe-stacks --stack-name CDKToolkit --region us-west-2
```
**Already run (read-only) as part of this research.** Result: the us-west-2 `CDKToolkit` stack (created 2019-05-25, last updated 2023-10-26, `UPDATE_COMPLETE`, `BootstrapVersion=18`) has **all-default parameters**:
- `Qualifier = hnb659fds` (the default qualifier — no custom `--qualifier` was ever used)
- `CloudFormationExecutionPolicies = ""` (empty → CLI's own default, i.e. `AdministratorAccess`)
- `TrustedAccounts = ""`, `TrustedAccountsForLookup = ""` (no `--trust`/`--trust-for-lookup` used)
- `FileAssetsBucketKmsKeyId = AWS_MANAGED_KEY`, no customer KMS key, no custom bucket name, no permissions boundary
- Stack has **no tags** on it

The us-east-1 stack (created 2021-06-27, last updated 2026-02-13, `BootstrapVersion=30`) has the identical default parameter shape — it's just been kept current. This confirms both are stock `cdk bootstrap` runs with no customization to preserve, so a re-bootstrap of us-west-2 to latest is a drop-in, no-parameter-loss operation.

### Exact command
```
AWS_PROFILE=admin npx cdk bootstrap aws://063257577013/us-west-2 \
  --tags project=dst-server-manager \
  --tags managed-by=cdk
```
Caveat: the `CDKToolkit` stack is **shared infrastructure** used by other production apps in the account, not owned by this project. Consider omitting the `project=dst-server-manager` tag (or use a neutral tag like `managed-by=cdk-bootstrap`) so the shared stack doesn't imply single-project ownership. Owner should confirm before running.

### Is v18 → v32 safe for other CDK apps already in us-west-2?
Generally yes — bootstrap upgrades are additive (new roles/permissions/resources), and AWS docs state re-running bootstrap on an existing stack only upgrades it "if necessary," is safe to do repeatedly, and other apps just see more permissions available, not fewer. One thing to flag to the owner from the version table:
- **v29 (ExternalId rejection):** if any other app/pipeline in us-west-2 does cross-account `AssumeRole` into these bootstrap roles *using an ExternalId*, that would break after upgrading past v29, unless explicitly disabled via `--no-bootstrap-deny-external-id`(check exact flag at bootstrap time). This is the one behavior change with real "breaking" potential in the v18→v32 range. Everything else (v20 ssm:GetParameters, v21 file-publishing condition, v22 session tags, v23 rollback perms, v24/25 bucket lifecycle changes, v26 KMS deletion policy, v27 EMR ECR policy, v28 refactor perms, v30 describe-stack-events, v31 GetHookResult, v32 managed-policy consolidation) is purely additive/permission-granting or lifecycle housekeeping, not something that removes access other apps rely on.
- No KMS customer key exists here (`AWS_MANAGED_KEY`), so the v15/v16/v18 KMS-tagging revert history doesn't apply.

**Recommendation:** re-bootstrap us-west-2 to latest, but tell the owner first (as instructed) and mention the ExternalId caveat above as the one thing worth a quick check ("does anything currently assume these bootstrap roles with an ExternalId?" — unlikely, but ask).

Source: [Bootstrap template version history](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html#bootstrap-template-history).

---

## 4. GitHub Actions OIDC deploy role

### Pattern (2026 recommended)
- The GitHub OIDC provider (`token.actions.githubusercontent.com`) already exists in the account — import it, never create it:
  ```ts
  const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
    this, 'GithubOidc',
    `arn:aws:iam::063257577013:oidc-provider/token.actions.githubusercontent.com`,
  );
  ```
- Create a dedicated deploy role trusted only by that provider, scoped by `StringEquals`/`StringLike` conditions:
  - `token.actions.githubusercontent.com:aud = sts.amazonaws.com`
  - `token.actions.githubusercontent.com:sub = repo:tylerschloesser/dst-server-manager:ref:refs/heads/main`
- The role's only permission: `sts:AssumeRole` on the six-ish bootstrap roles in **both** regions:
  `cdk-hnb659fds-deploy-role-063257577013-{us-east-1,us-west-2}`, `...-file-publishing-role-...`, `...-image-publishing-role-...`, `...-lookup-role-...` (image-publishing not strictly needed here since there are no container assets, but harmless to include for future-proofing).

### Chicken-and-egg
Correct — this deploy role, and the small "ci" stack that creates it (plus the `OpenIdConnectProvider.fromOpenIdConnectProviderArn` import), must be deployed **once, locally, by the owner with admin/SSO creds** (`AWS_PROFILE=admin`) before the GitHub Actions workflow can run, since the workflow has no credentials until that role exists.

### Minimal workflow YAML
```yaml
name: deploy
on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        # version pinned via packageManager field; corepack enables it below

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: corepack enable
      - run: pnpm install --frozen-lockfile

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::063257577013:role/github-actions-deploy
          aws-region: us-east-1   # region here just for the STS call; CDK stacks set their own `env`

      - run: pnpm exec cdk deploy --all --require-approval never
```
Note: `aws-actions/configure-aws-credentials` is currently on **major v4** in common use (marketplace listing shows newer minors/majors circulating — verify exact latest tag at implementation time, e.g. `v4` vs a newer major); functionally v4's OIDC flow is stable and widely used. Pin to a specific tag/SHA for supply-chain safety.

Sources: [aws-cdk-github-oidc](https://github.com/aripalo/aws-cdk-github-oidc), [OpenIdConnectProvider API docs](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_iam.OpenIdConnectProvider.html), [GitHub Docs: Configuring OIDC for AWS](https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services), [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials).

---

## 5. Cross-region value passing (us-east-1 web stack needs us-west-2 game-stack values)

Three options, assessed:

1. **`crossRegionReferences: true`** — convenient (auto-generates SSM Parameter + custom-resource "export reader/writer" plumbing across regions), but has real, documented reliability issues:
   - Long stack/construct names can produce SSM parameter names that push the custom resource's CloudFormation response over the 4096-byte limit, failing deployment ([#30119](https://github.com/aws/aws-cdk/issues/30119)).
   - The custom-resource Lambda's IAM role can hit permission/region-reachability issues when more than 2 regions are involved ([#24863](https://github.com/aws/aws-cdk/issues/24863)).
   - "Deadly embrace" circular-dependency failures when a cross-region export is removed while still referenced ([#34813](https://github.com/aws/aws-cdk/issues/34813)).
   - Values that change frequently (e.g., versioned ARNs) are a known pain point.
   - `--exclusively` deploys can fail if the producer stack for the reference hasn't been deployed yet ([#1119](https://github.com/aws/aws-cdk-cli/issues/1119)).

2. **Deterministic physical names** — set explicit `functionName`/`bucketName`/`tableName`/launch-template name in the game stack, then hardcode/derive the same string in the web stack (e.g. via a shared constants file) and use `Function.fromFunctionName`, `Bucket.fromBucketName`, etc. No cross-stack CFN dependency at all, works with any deploy order, no runtime custom resources.

3. **Explicit SSM parameters** — game stack writes `ssm.StringParameter`s in us-west-2; web stack reads them at synth-time via `StringParameter.valueFromLookup` (a *context* lookup, cached in `cdk.context.json`, requires re-running `cdk context --clear` to refresh) or at runtime from the Lambda via SDK `GetParameter` calls (fully dynamic, no synth-time coupling, but the Lambda needs `ssm:GetParameter` on a cross-region ARN and the lookup happens on every invocation unless cached).

**Recommendation: option 2 (deterministic names) for identifiers that are naturally stable (bucket name, table name, launch template name), combined with option 3-runtime (Lambda reads SSM at invocation, not synth) for the launch-template *id* if it's not deterministic.** This avoids `crossRegionReferences`'s custom-resource machinery entirely, which is the right call for a small single-maintainer app where debugging a stuck custom resource across regions is expensive. Given this project's small size, plain deterministic physical names for everything (skip SSM if possible) is the simplest robust option — reserve SSM only for values CDK truly can't set deterministically (e.g., an auto-generated launch template ID, if you don't pin `launchTemplateName` and read the ID via SDK at runtime instead of at synth-time).

Sources: [aws-cdk issue #30119](https://github.com/aws/aws-cdk/issues/30119), [#24863](https://github.com/aws/aws-cdk/issues/24863), [#34813](https://github.com/aws/aws-cdk/issues/34813), [aws-cdk-cli #1119](https://github.com/aws/aws-cdk-cli/issues/1119), [cross-region-stack-references ADR](https://github.com/aws/aws-cdk-lib/blob/main/packages/aws-cdk-lib/core/adr/cross-region-stack-references.md).

---

## 6. CloudFront + ACM + Route 53 with imported zone (`ty.ler.dev`, `Z038502736IM0QLQT7VFN`, record `dst.ty.ler.dev`)

Confirmed behavior (standard, well-documented CDK/CloudFormation semantics — not independently re-verified against a live deploy here, out of scope per AWS rules):
- `HostedZone.fromHostedZoneAttributes(...)` is a **reference only** — CDK does not manage the zone resource itself, only whatever record-set resources you explicitly create against it.
- `acm.Certificate(..., { validation: acm.CertificateValidation.fromDns(zone) })` creates exactly one (or one per SAN) `AWS::Route53::RecordSet` CNAME validation record scoped to the specific validation name/value CloudFormation computes — it does not touch any other records in the zone.
- `route53.ARecord` / `AaaaRecord` with `targets.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))` similarly create/own only the one named record (`dst.ty.ler.dev` A + AAAA) — again scoped by the explicit `recordName` you pass, no other records are read or modified.
- **On stack deletion:** CloudFormation deletes the record-set resources it created (the validation CNAME and the `dst` A/AAAA records) as part of normal stack teardown, same as any other resource — it does not touch or delete the hosted zone itself (which isn't a stack resource) or any records not created by this stack. If the validation CNAME was already deleted/cleaned up post-issuance in some flows that's independent of this teardown.
- Net: this pattern is safe for a shared zone that hosts other records for other sites — CDK's Route53 record constructs are scoped to the exact record name/type they declare, never zone-wide.

## 7. Tagging gaps

`Tags.of(app).add('project', 'dst-server-manager')` propagates via the CDK tag aspect system to resources that support CloudFormation-level tags declared as CDK constructs — but it does **not** reach resources created imperatively at runtime by AWS services rather than by CloudFormation:
- **EC2 instances launched from a `LaunchTemplate`** (e.g., by an Auto Scaling Group, or manually via `RunInstances` referencing the template) are **not tagged** by the stack-level `Tags.of(app)` aspect, because the instance itself isn't a CloudFormation resource in your stack — it's created later by EC2/ASG using the template. You must set `LaunchTemplate`'s `tagSpecifications` (`resourceType: 'instance'` and `resourceType: 'volume'`) explicitly so every instance/volume launched from it inherits the `project` tag (and anything a tag-scoped IAM condition or the reaper Lambda depends on).
- Similarly, **EBS volumes** created alongside those instances need their own `tagSpecifications` entry — they don't inherit tags from the instance automatically at the API level for IAM tag-condition purposes (some AWS docs describe volume tag propagation for cost allocation, but IAM `aws:ResourceTag` conditions need the volume's own tags set explicitly via the launch template).
- Anything created by a **Lambda custom resource** or by application code at runtime (not a CloudFormation resource) is likewise outside the `Tags.of(app)` aspect and needs explicit tagging in that code.
- S3 objects, DynamoDB items, and other data-plane "resources" are never tagged by this mechanism (tags apply to the bucket/table resource, not its contents).

**Practical implication for the reaper:** if it identifies orphaned instances by `project` tag, the launch template must set `tagSpecifications` for `instance` (and `volume`, if the reaper or an IAM condition also targets volumes) — otherwise every instance launched from it will be invisible to a tag-scoped scan/IAM condition despite the app-level `Tags.of()` call.

## 8. Vitest/Jest + cdk-nag

**One-line recommendation:** for a project this size, include the built-in `aws-cdk-lib/assertions` module with **Vitest** (lighter/faster than Jest, no meaningful CDK-specific advantage to Jest anymore) for a handful of snapshot/fine-grained assertion tests on the two stacks, and add `cdk-nag`'s `AwsSolutionsChecks` as a cheap, high-leverage guardrail (catches missing encryption, overly-broad IAM, public bucket exposure, etc. for free) — but don't over-invest in exhaustive test coverage for a single-maintainer hobby-scale app.

---

## AWS CLI calls made (read-only, no resources modified)
- `aws sts get-caller-identity --region us-west-2` (credentials valid, Admin SSO role)
- `aws cloudformation describe-stacks --stack-name CDKToolkit --region us-west-2`
- `aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1`
