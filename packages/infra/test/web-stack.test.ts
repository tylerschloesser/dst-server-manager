import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  ACCOUNT_ID,
  CONTROL_REGION,
  DOMAIN_NAME,
  GAME_REGION,
  HOSTED_ZONE_ID,
  INSTANCE_ROLE_NAME,
  JOIN_HOSTNAME,
  PROJECT,
} from '@dst/shared';
import { DstWebStack } from '../lib/web-stack';

function synth(budgetEnabled = true): Template {
  const app = new cdk.App();
  const stack = new DstWebStack(app, 'DstWeb', {
    env: { account: ACCOUNT_ID, region: CONTROL_REGION },
    stackName: 'DstWeb',
    apiBundlePath: path.resolve(__dirname, 'fixtures/api-bundle'),
    webDistPath: path.resolve(__dirname, 'fixtures/web-dist'),
    budgetEnabled,
  });
  return Template.fromStack(stack);
}

describe('DstWeb', () => {
  it('9. two Lambda::Permission for cloudfront.amazonaws.com on the API function: InvokeFunctionUrl and InvokeFunction, each scoped to the distribution', () => {
    const template = synth();
    const perms = template.findResources('AWS::Lambda::Permission', {
      Properties: { Principal: 'cloudfront.amazonaws.com' },
    });
    const entries = Object.values(perms) as Array<{ Properties: Record<string, unknown> }>;
    // Only the API function has a Function URL; the reaper has no CloudFront permission.
    const actions = entries.map((e) => e.Properties.Action).sort();
    expect(actions).toEqual(['lambda:InvokeFunction', 'lambda:InvokeFunctionUrl']);
    for (const entry of entries) {
      expect(entry.Properties.SourceArn).toBeDefined();
      expect(JSON.stringify(entry.Properties.SourceArn)).toMatch(/Dist/);
    }
  });

  it('10. Lambda::Url AuthType is AWS_IAM; no URL uses NONE', () => {
    const template = synth();
    const urls = template.findResources('AWS::Lambda::Url');
    const authTypes = Object.values(urls).map(
      (u) => (u as { Properties: { AuthType: string } }).Properties.AuthType,
    );
    expect(authTypes.length).toBeGreaterThan(0);
    for (const t of authTypes) expect(t).toBe('AWS_IAM');
  });

  it('11. no Route53 HostedZone is created', () => {
    const template = synth();
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
  });

  // `play.dst.ty.ler.dev` deliberately does NOT appear here: it is written at runtime by the
  // instance and the reaper (docs/decisions.md §17). A CDK-owned record would be reset to the sink
  // by every deploy that re-materialized it — including a deploy during a live session — and
  // would weaken this count from an invariant into a moving number.
  it('12. exactly two Route53 RecordSets, A + AAAA for dst.ty.ler.dev, nothing else', () => {
    const template = synth();
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
    const records = template.findResources('AWS::Route53::RecordSet');
    const byType = Object.fromEntries(
      Object.values(records).map((r) => {
        const props = (r as { Properties: { Type: string; Name: string } }).Properties;
        return [props.Type, props.Name];
      }),
    );
    expect(byType.A).toBe(`${DOMAIN_NAME}.`);
    expect(byType.AAAA).toBe(`${DOMAIN_NAME}.`);
    for (const r of Object.values(records)) {
      expect((r as { Properties: { Name: string } }).Properties.Name).toBe(`${DOMAIN_NAME}.`);
    }
  });

  it('13. /api/* behaviour: CachingDisabled + AllViewerExceptHostHeader, all methods; distribution Aliases and no CustomErrorResponses', () => {
    const template = synth();
    const dists = template.findResources('AWS::CloudFront::Distribution');
    const ids = Object.keys(dists);
    expect(ids).toHaveLength(1);
    const config = dists[ids[0]!]!.Properties.DistributionConfig as Record<string, unknown>;
    expect(config.Aliases).toEqual([DOMAIN_NAME]);
    expect(config.CustomErrorResponses).toBeUndefined();

    const behaviors = config.CacheBehaviors as Array<Record<string, unknown>>;
    const apiBehavior = behaviors.find((b) => b.PathPattern === '/api/*');
    expect(apiBehavior).toBeDefined();
    expect(apiBehavior!.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad'); // CachingDisabled
    expect(apiBehavior!.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac'); // AllViewerExceptHostHeader
    expect([...(apiBehavior!.AllowedMethods as string[])].sort()).toEqual(
      ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].sort(),
    );
  });

  it('14. reaper schedule: rate(5 minutes), enabled, single target', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'dst-server-manager-reaper',
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
    });
    const rules = template.findResources('AWS::Events::Rule');
    const ids = Object.keys(rules);
    expect(ids).toHaveLength(1);
    expect((rules[ids[0]!]!.Properties.Targets as unknown[]).length).toBe(1);
  });

  it('15. budget: $5 monthly, tag-scoped, three notifications with SNS subscribers; topic policy allows budgets.amazonaws.com', () => {
    const template = synth(true);
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: 5, Unit: 'USD' },
        TimeUnit: 'MONTHLY',
        CostFilters: { TagKeyValue: ['user:project$dst-server-manager'] },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 50 }),
          Subscribers: Match.arrayWith([Match.objectLike({ SubscriptionType: 'SNS' })]),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 100 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
        }),
      ]),
    });
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'budgets.amazonaws.com' },
            Action: 'SNS:Publish',
          }),
        ]),
      }),
    });
  });

  it('budgetEnabled=false skips the budget but still creates the topic and policy', () => {
    const template = synth(false);
    template.resourceCountIs('AWS::Budgets::Budget', 0);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::TopicPolicy', 1);
  });

  it('16. DynamoDB GlobalTable: Retain, on-demand', () => {
    const template = synth();
    template.hasResource(
      'AWS::DynamoDB::GlobalTable',
      Match.objectLike({
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({
          TableName: 'dst-server-manager',
          BillingMode: 'PAY_PER_REQUEST',
        }),
      }),
    );
  });

  it('17. both Lambdas nodejs22.x/arm64, exact handlers, API env exact and reaper has no PUBLIC_ORIGIN, neither has s3:* in role', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'dst-server-manager-api',
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'api.handler',
      Environment: {
        Variables: {
          APP_ENV: 'prod',
          PUBLIC_ORIGIN: 'https://dst.ty.ler.dev',
          NODE_OPTIONS: '--enable-source-maps',
        },
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'dst-server-manager-reaper',
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'reaper.handler',
    });

    const reaperFn = Object.values(
      template.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'dst-server-manager-reaper' },
      }),
    )[0] as { Properties: { Environment: { Variables: Record<string, string> } } };
    expect(reaperFn.Properties.Environment.Variables.PUBLIC_ORIGIN).toBeUndefined();

    // Only the API and reaper function roles matter here — the CDK-managed BucketDeployment
    // custom-resource Lambda role legitimately needs s3:* to push the site assets (§4.5) and is
    // not one of "neither Lambda" in decisions §16.17.
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: Match.stringLikeRegexp('^(Api|Reaper)ServiceRoleDefaultPolicy') },
    });
    expect(Object.keys(policies)).toHaveLength(2);
    for (const policy of Object.values(policies)) {
      const statements = (
        policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
      ).Properties.PolicyDocument.Statement;
      for (const statement of statements) {
        const actions = ([] as string[]).concat((statement.Action as string | string[]) ?? []);
        for (const action of actions) {
          expect(action.startsWith('s3:')).toBe(false);
        }
      }
    }
  });

  it('17ter. API role can actually launch: RunInstances on the public-AMI image ARN (empty account field), tag-conditioned instance/volume, CreateTags only on create, PassRole to EC2', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: Match.stringLikeRegexp('^ApiServiceRoleDefaultPolicy') },
    });
    expect(Object.keys(policies)).toHaveLength(1);
    const statements = (
      Object.values(policies)[0] as {
        Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
      }
    ).Properties.PolicyDocument.Statement;
    const bySid = new Map(statements.map((s) => [s.Sid as string, s]));
    const actionsOf = (sid: string): string[] =>
      ([] as string[]).concat((bySid.get(sid)?.Action as string | string[]) ?? []);
    const resourcesOf = (sid: string): string[] =>
      ([] as string[]).concat((bySid.get(sid)?.Resource as string | string[]) ?? []);

    const ec2 = `arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}`;
    const instanceArn = `${ec2}:instance/*`;
    const volumeArn = `${ec2}:volume/*`;

    // Untagged RunInstances resources. The image ARN of a public (Canonical-owned) AMI has no
    // account id; an account-qualified image/* denies every launch.
    expect(actionsOf('RunInstancesResources')).toEqual(['ec2:RunInstances']);
    expect(resourcesOf('RunInstancesResources').sort()).toEqual(
      [
        `arn:aws:ec2:${GAME_REGION}::image/*`,
        `${ec2}:launch-template/*`,
        `${ec2}:network-interface/*`,
        `${ec2}:security-group/*`,
        `${ec2}:subnet/*`,
      ].sort(),
    );

    // Tag-scoped instance + volume creation (decisions §16.16).
    expect(actionsOf('RunInstancesTaggedResources')).toEqual(['ec2:RunInstances']);
    expect(resourcesOf('RunInstancesTaggedResources').sort()).toEqual(
      [instanceArn, volumeArn].sort(),
    );
    expect(bySid.get('RunInstancesTaggedResources')?.Condition).toEqual({
      StringEquals: { 'aws:RequestTag/project': PROJECT, 'aws:RequestTag/role': 'game' },
      'ForAllValues:StringEquals': { 'aws:TagKeys': ['project', 'role', 'sessionId', 'Name'] },
    });

    // Launch-time tagging only, never re-tagging.
    expect(actionsOf('CreateTagsOnLaunch')).toEqual(['ec2:CreateTags']);
    expect(resourcesOf('CreateTagsOnLaunch').sort()).toEqual([instanceArn, volumeArn].sort());
    expect(bySid.get('CreateTagsOnLaunch')?.Condition).toEqual({
      StringEquals: { 'ec2:CreateAction': 'RunInstances' },
    });

    // The launch template carries the instance profile, so RunInstances needs PassRole.
    expect(actionsOf('PassInstanceRole')).toEqual(['iam:PassRole']);
    expect(resourcesOf('PassInstanceRole')).toEqual([
      `arn:aws:iam::${ACCOUNT_ID}:role/${INSTANCE_ROLE_NAME}`,
    ]);
    expect(bySid.get('PassInstanceRole')?.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' },
    });

    // Subnet discovery in the launcher adapter (packages/api/src/adapters/ec2-launcher.ts).
    expect(actionsOf('DescribeEc2').sort()).toEqual([
      'ec2:DescribeInstances',
      'ec2:DescribeSubnets',
      'ec2:DescribeVpcs',
    ]);
    expect(resourcesOf('DescribeEc2')).toEqual(['*']);

    // And the reaper keeps its tag-conditioned terminate (decisions §7).
    const reaperPolicies = template.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: Match.stringLikeRegexp('^ReaperServiceRoleDefaultPolicy') },
    });
    const reaperStatements = (
      Object.values(reaperPolicies)[0] as {
        Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
      }
    ).Properties.PolicyDocument.Statement;
    const terminate = reaperStatements.find((s) => s.Sid === 'TerminateTaggedInstances');
    expect(terminate?.Action).toEqual('ec2:TerminateInstances');
    expect(terminate?.Resource).toEqual(instanceArn);
    expect(terminate?.Condition).toEqual({
      StringEquals: { 'ec2:ResourceTag/project': PROJECT },
    });

    // The reaper's DNS backstop, scoped exactly as the instance role's is (docs/infra.md §4.4).
    const dns = reaperStatements.find((s) => s.Sid === 'JoinDnsRecord');
    expect(dns?.Action).toEqual('route53:ChangeResourceRecordSets');
    expect(dns?.Resource).toEqual(`arn:aws:route53:::hostedzone/${HOSTED_ZONE_ID}`);
    expect(dns?.Condition).toEqual({
      'ForAllValues:StringEquals': {
        'route53:ChangeResourceRecordSetsNormalizedRecordNames': [JOIN_HOSTNAME],
        'route53:ChangeResourceRecordSetsRecordTypes': ['A'],
      },
    });

    // And the API Lambda never touches DNS.
    expect(JSON.stringify(statements)).not.toContain('route53:');
  });

  it('17bis. site bucket Retain, no autodelete; response headers policy has Referrer-Policy no-referrer and HSTS includeSubdomains', () => {
    const template = synth();
    template.hasResource(
      'AWS::S3::Bucket',
      Match.objectLike({
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({ BucketName: 'dst-server-manager-site-063257577013' }),
      }),
    );
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);

    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
          StrictTransportSecurity: Match.objectLike({ IncludeSubdomains: true }),
        }),
      }),
    });
  });
});
