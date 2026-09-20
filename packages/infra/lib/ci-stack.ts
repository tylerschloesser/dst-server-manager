// DstCi (us-east-1): GitHub OIDC deploy role. Deployed once, locally, with AWS_PROFILE=admin; the
// deploy workflow never deploys it (it has no credentials until this role exists).
// docs/infra.md §2, docs/decisions.md §12.
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ACCOUNT_ID, CONTROL_REGION, GAME_REGION } from '@dst/shared';

const GITHUB_REPO_SUB = 'repo:tylerschloesser/dst-server-manager:ref:refs/heads/main';

export class DstCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // The OIDC provider already exists and is shared with other sites in this account: import it,
    // never create it (docs/infra.md §2, decisions §12).
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidc',
      `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`,
    );

    const bootstrapRoles = ['deploy-role', 'file-publishing-role', 'lookup-role'].flatMap((r) =>
      [CONTROL_REGION, GAME_REGION].map(
        (g) => `arn:aws:iam::${ACCOUNT_ID}:role/cdk-hnb659fds-${r}-${ACCOUNT_ID}-${g}`,
      ),
    );

    const role = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'dst-server-manager-github-deploy',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': GITHUB_REPO_SUB,
        },
      }),
    });

    // This sts:AssumeRole statement is the role's only permission (docs/infra.md §2).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: bootstrapRoles,
      }),
    );
  }
}
