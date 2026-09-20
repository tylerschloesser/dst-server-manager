import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  ACCOUNT_ID,
  GAME_REGION,
  TABLE_NAME,
  CONTROL_REGION,
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
});
