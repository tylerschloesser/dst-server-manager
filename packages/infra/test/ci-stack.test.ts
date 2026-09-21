import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ACCOUNT_ID, CONTROL_REGION } from '@dst/shared';
import { DstCiStack } from '../lib/ci-stack';

function synth(): Template {
  const app = new cdk.App();
  const stack = new DstCiStack(app, 'DstCi', {
    env: { account: ACCOUNT_ID, region: CONTROL_REGION },
    stackName: 'DstCi',
  });
  return Template.fromStack(stack);
}

describe('DstCi', () => {
  it('trusts the GitHub OIDC provider with StringEquals aud/sub (never StringLike)', () => {
    const template = synth();
    template.hasResourceProperties(
      'AWS::IAM::Role',
      Match.objectLike({
        RoleName: 'dst-server-manager-github-deploy',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sts:AssumeRoleWithWebIdentity',
              Principal: {
                Federated:
                  'arn:aws:iam::063257577013:oidc-provider/token.actions.githubusercontent.com',
              },
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub':
                    'repo:tylerschloesser@2300885/dst-server-manager@1377732613:ref:refs/heads/main',
                },
              },
            }),
          ]),
        }),
      }),
    );
  });

  it('creates no OIDC provider (imported, never created)', () => {
    const template = synth();
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });

  it('has exactly one inline policy statement: sts:AssumeRole over only cdk-hnb659fds-* ARNs in both regions', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const ids = Object.keys(policies);
    expect(ids).toHaveLength(1);
    const policy = policies[ids[0]!]!;
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    const statement = statements[0];
    expect(statement.Effect).toBe('Allow');
    expect(statement.Action).toBe('sts:AssumeRole');
    const resources: string[] = statement.Resource;
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(resource).toMatch(/^arn:aws:iam::063257577013:role\/cdk-hnb659fds-/);
    }
    expect(resources.some((r) => r.endsWith('-us-east-1'))).toBe(true);
    expect(resources.some((r) => r.endsWith('-us-west-2'))).toBe(true);
  });
});
