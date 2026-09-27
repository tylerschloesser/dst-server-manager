import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  ACCOUNT_ID,
  DIGEST_FUNCTION_NAME,
  GAME_REGION,
  HOSTED_ZONE_ID,
  JOIN_HOSTNAME,
  TABLE_NAME,
  CONTROL_REGION,
  PARAM_ANTHROPIC_API_KEY,
  PARAM_USERS,
  PROJECT,
} from '@dst/shared';
import { DstGameStack } from '../lib/game-stack';

function synth(): { template: Template; stack: cdk.Stack; templateJson: Record<string, unknown> } {
  const app = new cdk.App();
  const stack = new DstGameStack(app, 'DstGame', {
    env: { account: ACCOUNT_ID, region: GAME_REGION },
    stackName: 'DstGame',
    supervisorBundlePath: path.resolve(__dirname, 'fixtures/supervisor-bundle'),
    userDataPath: path.resolve(__dirname, 'fixtures/user-data.sh'),
    digestBundlePath: path.resolve(__dirname, 'fixtures/digest-bundle'),
  });
  // Mirrors bin/app.ts's Tags.of(app).add('project', PROJECT) — applied at the app level in the
  // real app, so an isolated stack test must replicate it to exercise the same tag aspect.
  cdk.Tags.of(app).add('project', PROJECT);
  const template = Template.fromStack(stack);
  return { template, stack, templateJson: template.toJSON() };
}

/** Suffix of an S3 ARN rendered as `{"Fn::Join": ["", [<bucket arn token>, "<suffix>"]]}` or a
 *  plain string (already-resolved literal). */
function arnSuffix(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  const join = (entry as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (join) {
    const parts = join[1];
    return String(parts[parts.length - 1]);
  }
  throw new Error(`unrecognized ARN shape: ${JSON.stringify(entry)}`);
}

describe('DstGame', () => {
  it('1. data bucket: Retain, versioned, block public access all true', () => {
    const { template } = synth();
    template.hasResource(
      'AWS::S3::Bucket',
      Match.objectLike({
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({
          BucketName: 'dst-server-manager-data-063257577013',
          VersioningConfiguration: { Status: 'Enabled' },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        }),
      }),
    );
  });

  it('2. no Custom::S3AutoDeleteObjects resource', () => {
    const { template } = synth();
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('3. bucket policy denies delete outside exactly the six scratch prefixes', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const ids = Object.keys(policies);
    expect(ids).toHaveLength(1);
    const statements = policies[ids[0]!]!.Properties.PolicyDocument.Statement as Array<{
      Sid?: string;
      Effect: string;
      Action: string[];
      NotResource: unknown[];
    }>;
    const deny = statements.find((s) => s.Sid === 'DenyDeleteOutsideScratchPrefixes');
    expect(deny).toBeDefined();
    expect(deny!.Effect).toBe('Deny');
    expect([...deny!.Action].sort()).toEqual(['s3:DeleteObject', 's3:DeleteObjectVersion']);
    const suffixes = deny!.NotResource.map(arnSuffix).sort();
    expect(suffixes).toEqual(
      [
        '/runtime/*',
        '/runtime-cache/*',
        '/binaries/*',
        '/worlds/test-*',
        '/inflight/test-*',
        '/sessions/test-*',
      ].sort(),
    );
  });

  it('4. lifecycle: exactly three rules, no seed/sessions rule, no top-level ExpirationInDays', () => {
    const { template } = synth();
    const buckets = template.findResources('AWS::S3::Bucket', {
      Properties: { BucketName: 'dst-server-manager-data-063257577013' },
    });
    const ids = Object.keys(buckets);
    expect(ids).toHaveLength(1);
    const rules = buckets[ids[0]!]!.Properties.LifecycleConfiguration.Rules as Array<
      Record<string, unknown>
    >;
    expect(rules).toHaveLength(3);

    const worlds = rules.find((r) => r.Prefix === 'worlds/');
    expect(worlds).toMatchObject({
      Status: 'Enabled',
      NoncurrentVersionExpiration: { NoncurrentDays: 30, NewerNoncurrentVersions: 10 },
    });
    expect(worlds!.ExpirationInDays).toBeUndefined();

    const inflight = rules.find((r) => r.Prefix === 'inflight/');
    expect(inflight).toMatchObject({
      Status: 'Enabled',
      NoncurrentVersionExpiration: { NoncurrentDays: 7, NewerNoncurrentVersions: 3 },
    });
    expect(inflight!.ExpirationInDays).toBeUndefined();

    const abortMpu = rules.find(
      (r) => r.AbortIncompleteMultipartUpload as Record<string, unknown> | undefined,
    );
    expect(abortMpu).toBeDefined();
    expect(abortMpu!.AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 7 });
    expect(abortMpu!.NoncurrentVersionExpiration).toBeUndefined();
    expect(abortMpu!.ExpirationInDays).toBeUndefined();

    for (const rule of rules) {
      expect(rule.Prefix === 'seed/' || rule.Prefix === 'sessions/').toBe(false);
    }
  });

  it('5. security group: exactly one ingress, udp 10998-10999 from 0.0.0.0/0, never tcp or port 22', () => {
    const { template } = synth();
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    const ids = Object.keys(groups);
    expect(ids).toHaveLength(1);
    const props = groups[ids[0]!]!.Properties;
    const ingress = [
      ...(props.SecurityGroupIngress ?? []),
      ...Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map(
        (r) => (r as { Properties: Record<string, unknown> }).Properties,
      ),
    ];
    expect(ingress).toHaveLength(1);
    const rule = ingress[0] as Record<string, unknown>;
    expect(rule.IpProtocol).toBe('udp');
    expect(rule.FromPort).toBe(10998);
    expect(rule.ToPort).toBe(10999);
    expect(rule.CidrIp).toBe('0.0.0.0/0');

    const json = JSON.stringify(ingress);
    expect(json).not.toMatch(/"tcp"/);
    expect(json.includes('"FromPort":22') || json.includes('"ToPort":22')).toBe(false);
  });

  it('6. launch template data: imds required, terminate, c6i.large, canonical AMI, 20GB gp3 encrypted, tag specs on instance+volume', () => {
    const { template, templateJson } = synth();
    const templates = template.findResources('AWS::EC2::LaunchTemplate');
    const ids = Object.keys(templates);
    expect(ids).toHaveLength(1);
    const data = templates[ids[0]!]!.Properties.LaunchTemplateData as Record<string, unknown>;

    expect((data.MetadataOptions as Record<string, unknown>).HttpTokens).toBe('required');
    expect(data.InstanceInitiatedShutdownBehavior).toBe('terminate');
    expect(data.InstanceType).toBe('c6i.large');

    // `MachineImage.fromSsmParameter` resolves the AMI via a CloudFormation template Parameter of
    // type `AWS::SSM::Parameter::Value<...>` whose Default is the Canonical SSM parameter path —
    // CloudFormation resolves it at deploy time (decisions §5).
    const imageId = data.ImageId as { Ref: string };
    expect(imageId.Ref).toBeDefined();
    const param = (templateJson.Parameters as Record<string, { Type: string; Default: string }>)[
      imageId.Ref
    ];
    expect(param).toBeDefined();
    expect(param!.Type).toMatch(/^AWS::SSM::Parameter::Value</);
    expect(param!.Default).toMatch(/^\/aws\/service\/canonical\//);

    const devices = data.BlockDeviceMappings as Array<Record<string, unknown>>;
    expect(devices).toHaveLength(1);
    const ebs = devices[0]!.Ebs as Record<string, unknown>;
    expect(ebs.VolumeSize).toBe(20);
    expect(ebs.VolumeType).toBe('gp3');
    expect(ebs.Encrypted).toBe(true);

    const tagSpecs = data.TagSpecifications as Array<{
      ResourceType: string;
      Tags: Array<{ Key: string; Value: string }>;
    }>;
    const resourceTypes = tagSpecs.map((t) => t.ResourceType).sort();
    expect(resourceTypes).toEqual(['instance', 'volume']);
    for (const spec of tagSpecs) {
      const tagMap = Object.fromEntries(spec.Tags.map((t) => [t.Key, t.Value]));
      expect(tagMap.project).toBe('dst-server-manager');
      expect(tagMap.role).toBe('game');
      expect(tagMap.Name).toBe('dst-game');
    }
  });

  it('7. launch template has no NetworkInterfaces and does have SecurityGroupIds', () => {
    const { template } = synth();
    const templates = template.findResources('AWS::EC2::LaunchTemplate');
    const ids = Object.keys(templates);
    const data = templates[ids[0]!]!.Properties.LaunchTemplateData as Record<string, unknown>;
    expect(data.NetworkInterfaces).toBeUndefined();
    expect(data.SecurityGroupIds).toBeDefined();
  });

  it('8. instance role: no s3:Delete*, no ec2: actions at all; dynamodb + ssm resources exact', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: Match.anyValue() },
    });
    const rolePolicy = Object.values(policies).find((p) =>
      (p as { Properties: { PolicyName?: string } }).Properties.PolicyName?.includes(
        'InstanceRole',
      ),
    ) as
      { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } } | undefined;
    expect(rolePolicy).toBeDefined();
    const statements = rolePolicy!.Properties.PolicyDocument.Statement;

    const json = JSON.stringify(statements);
    expect(json).not.toMatch(/s3:Delete/);
    for (const statement of statements) {
      const actions = ([] as string[]).concat(statement.Action as string | string[]);
      for (const action of actions) {
        expect(action.startsWith('ec2:')).toBe(false);
      }
    }

    const stateStatement = statements.find((s) => s.Sid === 'State') as { Resource: unknown };
    expect(stateStatement.Resource).toBe(
      `arn:aws:dynamodb:${CONTROL_REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}`,
    );

    const secretsStatement = statements.find((s) => s.Sid === 'Secrets') as { Resource: string[] };
    expect([...secretsStatement.Resource].sort()).toEqual(
      [
        `arn:aws:ssm:${GAME_REGION}:${ACCOUNT_ID}:parameter/dst/klei-token`,
        `arn:aws:ssm:${GAME_REGION}:${ACCOUNT_ID}:parameter/dst/cluster-password`,
      ].sort(),
    );
    expect(JSON.stringify(secretsStatement.Resource)).not.toContain(PARAM_USERS);
  });

  it('8bis. instance role may change exactly one Route53 record: play.dst.ty.ler.dev, type A', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: Match.anyValue() },
    });
    const rolePolicy = Object.values(policies).find((p) =>
      (p as { Properties: { PolicyName?: string } }).Properties.PolicyName?.includes(
        'InstanceRole',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const statements = rolePolicy.Properties.PolicyDocument.Statement;

    const route53Statements = statements.filter((statement) =>
      ([] as string[])
        .concat(statement.Action as string | string[])
        .some((action) => action.startsWith('route53:')),
    );
    expect(route53Statements).toHaveLength(1);
    const dns = route53Statements[0] as Record<string, unknown>;
    expect(dns.Sid).toBe('JoinDnsRecord');
    expect(dns.Action).toBe('route53:ChangeResourceRecordSets');
    expect(dns.Resource).toBe(`arn:aws:route53:::hostedzone/${HOSTED_ZONE_ID}`);
    // The condition keys are the whole safety story: without them this grants the instance write
    // access to every record in a zone that serves other production sites. The name is the
    // normalized form — lowercase, no trailing dot — or every call is an AccessDenied at runtime.
    expect(dns.Condition).toEqual({
      'ForAllValues:StringEquals': {
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': [JOIN_HOSTNAME],
        'route53:ChangeResourceRecordSetsRecordTypes': ['A'],
      },
    });
    expect(JOIN_HOSTNAME.endsWith('.')).toBe(false);
    expect(JSON.stringify(statements)).not.toContain('route53:*');
  });

  // ---- Session digest (docs/infra.md §3.7) ----

  it('21. digest function: nodejs22.x/arm64, digest.handler, 1536 MB, 300 s, no VPC, exact env, explicit one-month log group, tagged', () => {
    const { template, templateJson } = synth();
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: DIGEST_FUNCTION_NAME },
    });
    expect(Object.keys(fns)).toHaveLength(1);
    const props = (Object.values(fns)[0] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.Handler).toBe('digest.handler');
    expect(props.MemorySize).toBe(1536);
    expect(props.Timeout).toBe(300);
    // Outside any VPC: it needs internet egress to api.anthropic.com and there is no NAT, ever.
    expect(props.VpcConfig).toBeUndefined();
    // No reserved concurrency: the account hosts other sites (docs/infra.md §3.7).
    expect(props.ReservedConcurrentExecutions).toBeUndefined();
    expect(props.Environment).toEqual({
      Variables: { APP_ENV: 'prod', NODE_OPTIONS: '--enable-source-maps' },
    });
    const tags = Object.fromEntries(
      (props.Tags as Array<{ Key: string; Value: string }>).map((t) => [t.Key, t.Value]),
    );
    expect(tags.project).toBe(PROJECT);

    // The explicit log group (an implicit one would be untagged and never expire).
    const logGroupRef = (props.LoggingConfig as { LogGroup: { Ref: string } }).LogGroup.Ref;
    const logGroup = (
      templateJson.Resources as Record<
        string,
        { Type: string; Properties: Record<string, unknown> }
      >
    )[logGroupRef];
    expect(logGroup?.Type).toBe('AWS::Logs::LogGroup');
    expect(logGroup?.Properties.LogGroupName).toBe(`/aws/lambda/${DIGEST_FUNCTION_NAME}`);
    expect(logGroup?.Properties.RetentionInDays).toBe(30);
    expect(logGroup?.Properties.Tags).toEqual([{ Key: 'project', Value: PROJECT }]);
  });

  it('22. digest async invoke: exactly one retry (a retry re-bills the LLM call)', () => {
    const { template } = synth();
    const configs = template.findResources('AWS::Lambda::EventInvokeConfig');
    expect(Object.keys(configs)).toHaveLength(1);
    const props = (Object.values(configs)[0] as { Properties: Record<string, unknown> }).Properties;
    expect(props.MaximumRetryAttempts).toBe(1);
    expect(props.FunctionName).toEqual({ Ref: expect.stringMatching(/^Digest/) });
  });

  it('23. digest role: exactly seven statements, each with exact actions, resources and conditions', () => {
    const { template } = synth();
    const statements = digestStatements(template);
    const bySid = new Map(statements.map((s) => [s.Sid as string, s]));
    expect(statements).toHaveLength(7);
    expect([...bySid.keys()].sort()).toEqual(
      [
        'ReadSaveVersions',
        'ReadSessions',
        'WriteDigest',
        'ListSessions',
        'ReadAnthropicKey',
        'DecryptAnthropicKey',
        'ReadNote',
      ].sort(),
    );
    for (const s of statements) expect(s.Effect).toBe('Allow');

    expect(actionsOf(bySid.get('ReadSaveVersions')).sort()).toEqual([
      's3:GetObject',
      's3:GetObjectVersion',
    ]);
    expect(resourcesOf(bySid.get('ReadSaveVersions')).map(arnSuffix)).toEqual(['/worlds/*']);

    expect(actionsOf(bySid.get('ReadSessions'))).toEqual(['s3:GetObject']);
    expect(resourcesOf(bySid.get('ReadSessions')).map(arnSuffix)).toEqual(['/sessions/*']);

    expect(actionsOf(bySid.get('WriteDigest'))).toEqual(['s3:PutObject']);
    expect(resourcesOf(bySid.get('WriteDigest')).map(arnSuffix)).toEqual(['/sessions/*/digest/*']);

    expect(actionsOf(bySid.get('ListSessions'))).toEqual(['s3:ListBucket']);
    expect(resourcesOf(bySid.get('ListSessions'))).toEqual([
      { 'Fn::GetAtt': [expect.stringMatching(/^Data/), 'Arn'] },
    ]);
    expect(bySid.get('ListSessions')?.Condition).toEqual({
      StringLike: { 's3:prefix': ['sessions/*'] },
    });

    expect(actionsOf(bySid.get('ReadAnthropicKey'))).toEqual(['ssm:GetParameter']);
    expect(resourcesOf(bySid.get('ReadAnthropicKey'))).toEqual([
      `arn:aws:ssm:${GAME_REGION}:${ACCOUNT_ID}:parameter/dst/anthropic-api-key`,
    ]);
    expect(PARAM_ANTHROPIC_API_KEY).toBe('/dst/anthropic-api-key');

    expect(actionsOf(bySid.get('DecryptAnthropicKey'))).toEqual(['kms:Decrypt']);
    expect(resourcesOf(bySid.get('DecryptAnthropicKey'))).toEqual([
      `arn:aws:kms:${GAME_REGION}:${ACCOUNT_ID}:key/*`,
    ]);
    expect(bySid.get('DecryptAnthropicKey')?.Condition).toEqual({
      StringEquals: { 'kms:ViaService': `ssm.${GAME_REGION}.amazonaws.com` },
    });

    expect(actionsOf(bySid.get('ReadNote'))).toEqual(['dynamodb:GetItem']);
    expect(resourcesOf(bySid.get('ReadNote'))).toEqual([
      `arn:aws:dynamodb:${CONTROL_REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}`,
    ]);
    expect(bySid.get('ReadNote')?.Condition).toEqual({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['NOTE'] },
    });
  });

  it('24. digest role: no delete, no write outside sessions/*/digest/*, no seed/, no wildcard action, no other secret', () => {
    const { template } = synth();
    const statements = digestStatements(template);
    const json = JSON.stringify(statements);
    expect(json).not.toMatch(/s3:Delete/);
    expect(json).not.toMatch(/seed\//);
    expect(json).not.toMatch(/inflight\//);
    expect(json).not.toMatch(/s3:ListBucketVersions/);
    expect(json).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|Query|Scan)/);
    expect(json).not.toContain('/dst/klei-token');
    expect(json).not.toContain('/dst/cluster-password');
    for (const s of statements) {
      for (const action of actionsOf(s)) {
        expect(action.includes('*'), action).toBe(false);
        // Every S3 action that is not a read is PutObject, and only on the digest subtree.
        if (action.startsWith('s3:') && !/^s3:(Get|List)/.test(action)) {
          expect(action).toBe('s3:PutObject');
          expect(resourcesOf(s).map(arnSuffix)).toEqual(['/sessions/*/digest/*']);
        }
      }
    }
    // Only the AWS-managed basic execution policy (logs) is attached; nothing broader.
    const roles = template.findResources('AWS::IAM::Role');
    const digestRole = Object.entries(roles).find(([id]) => id.startsWith('DigestServiceRole'));
    expect(digestRole).toBeDefined();
    const managed = JSON.stringify(
      (digestRole![1] as { Properties: { ManagedPolicyArns: unknown } }).Properties
        .ManagedPolicyArns,
    );
    expect(managed).toContain('service-role/AWSLambdaBasicExecutionRole');
    expect(managed).not.toMatch(/FullAccess|AdministratorAccess|VPCAccess/);
  });

  it('25. bucket notification: exactly one, ObjectCreated on prefix sessions/ + suffix manifest.json -> digest; Managed (full replace), nothing else configured', () => {
    const { template } = synth();
    const notes = template.findResources('Custom::S3BucketNotifications');
    expect(Object.keys(notes)).toHaveLength(1);
    const props = (Object.values(notes)[0] as { Properties: Record<string, unknown> }).Properties;
    expect(props.BucketName).toEqual({ Ref: expect.stringMatching(/^Data/) });
    // Managed: this stack owns the bucket, so the handler REPLACES the whole configuration (and
    // writes {} on delete). Safe only while this is the bucket's sole notification (§3.7).
    expect(props.Managed).toBe(true);
    const config = props.NotificationConfiguration as Record<string, unknown>;
    expect(Object.keys(config)).toEqual(['LambdaFunctionConfigurations']);
    const lambdas = config.LambdaFunctionConfigurations as Array<Record<string, unknown>>;
    expect(lambdas).toHaveLength(1);
    expect(lambdas[0]!.Events).toEqual(['s3:ObjectCreated:*']);
    expect(lambdas[0]!.LambdaFunctionArn).toEqual({
      'Fn::GetAtt': [expect.stringMatching(/^Digest/), 'Arn'],
    });
    const rules = (
      lambdas[0]!.Filter as { Key: { FilterRules: Array<{ Name: string; Value: string }> } }
    ).Key.FilterRules;
    expect(Object.fromEntries(rules.map((r) => [r.Name.toLowerCase(), r.Value]))).toEqual({
      prefix: 'sessions/',
      suffix: 'manifest.json',
    });
  });

  it('26. S3 may invoke the digest only from this bucket in this account; the notifications handler may only PutBucketNotification on it; nothing but the runtime deployment deletes', () => {
    const { template } = synth();
    const perms = template.findResources('AWS::Lambda::Permission', {
      Properties: { Principal: 's3.amazonaws.com' },
    });
    expect(Object.keys(perms)).toHaveLength(1);
    const perm = (Object.values(perms)[0] as { Properties: Record<string, unknown> }).Properties;
    expect(perm.Action).toBe('lambda:InvokeFunction');
    expect(perm.FunctionName).toEqual({
      'Fn::GetAtt': [expect.stringMatching(/^Digest/), 'Arn'],
    });
    expect(perm.SourceAccount).toBe(ACCOUNT_ID);
    expect(perm.SourceArn).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Data/), 'Arn'] });

    const handlerPolicies = template.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: Match.stringLikeRegexp('^DataNotificationsHandlerPolicy') },
    });
    expect(Object.keys(handlerPolicies)).toHaveLength(1);
    const statements = (
      Object.values(handlerPolicies)[0] as {
        Properties: { PolicyDocument: { Statement: Statement[] } };
      }
    ).Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]!.Action).toBe('s3:PutBucketNotification');
    expect(statements[0]!.Resource).toEqual({
      'Fn::GetAtt': [expect.stringMatching(/^Data/), 'Arn'],
    });

    // Across the whole stack, only the BucketDeployment role (runtime/ prune) may delete.
    for (const [id, policy] of Object.entries(template.findResources('AWS::IAM::Policy'))) {
      if (id.startsWith('CustomCDKBucketDeployment')) continue;
      expect(JSON.stringify(policy), id).not.toMatch(/s3:Delete|"s3:\*"/);
    }
  });

  it('27. exactly three Lambda functions in DstGame: the digest plus the two CDK plumbing handlers', () => {
    const { template } = synth();
    const ids = Object.keys(template.findResources('AWS::Lambda::Function'));
    expect(ids).toHaveLength(3);
    expect(ids.filter((id) => id.startsWith('Digest'))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith('CustomCDKBucketDeployment'))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith('BucketNotificationsHandler'))).toHaveLength(1);
  });
});

type Statement = Record<string, unknown>;

const actionsOf = (s: Statement | undefined): string[] =>
  ([] as string[]).concat((s?.Action as string | string[] | undefined) ?? []);

const resourcesOf = (s: Statement | undefined): unknown[] =>
  ([] as unknown[]).concat((s?.Resource as unknown) ?? []);

function digestStatements(template: Template): Statement[] {
  const policies = template.findResources('AWS::IAM::Policy', {
    Properties: { PolicyName: Match.stringLikeRegexp('^DigestServiceRoleDefaultPolicy') },
  });
  expect(Object.keys(policies)).toHaveLength(1);
  return (
    Object.values(policies)[0] as { Properties: { PolicyDocument: { Statement: Statement[] } } }
  ).Properties.PolicyDocument.Statement;
}
