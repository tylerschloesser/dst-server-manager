// DstWeb (us-east-1): DynamoDB table, API + reaper Lambdas, CloudFront + OAC in front of the
// Lambda Function URL and the site bucket, DNS, reaper schedule, budget. docs/infra.md §4.
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import {
  ACCOUNT_ID,
  API_FUNCTION_NAME,
  CONTROL_REGION,
  DOMAIN_NAME,
  GAME_REGION,
  HOSTED_ZONE_ID,
  INSTANCE_ROLE_NAME,
  PARAM_CLUSTER_PASSWORD,
  PARAM_SESSION_SECRET,
  PARAM_USERS,
  PROJECT,
  PUBLIC_ORIGIN_PROD,
  REAPER_FUNCTION_NAME,
  SITE_BUCKET,
  SPA_CSP,
  TABLE_NAME,
  ZONE_NAME,
} from '@dst/shared';

export interface DstWebStackProps extends cdk.StackProps {
  /** esbuild output deployed as both Lambdas' code (docs/control-plane.md §5.2). */
  apiBundlePath: string;
  /** `vite build` output (docs/web.md §8). */
  webDistPath: string;
  /** decisions §16.20: false skips the CfnBudget while the cost-allocation tag is not active. */
  budgetEnabled: boolean;
}

export class DstWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DstWebStackProps) {
    super(scope, id, props);

    // 4.1 DynamoDB.
    const table = new dynamodb.TableV2(this, 'Table', {
      tableName: TABLE_NAME,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 4.2 Lambdas. One bundler, and what is tested is what ships (decisions §16.29): plain
    // lambda.Function + Code.fromAsset only — no bundling prop, no esbuild and no Docker anywhere
    // inside CDK.
    const apiCode = lambda.Code.fromAsset(props.apiBundlePath);

    const apiLogs = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: `/aws/lambda/${API_FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const api = new lambda.Function(this, 'Api', {
      functionName: API_FUNCTION_NAME,
      code: apiCode,
      handler: 'api.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      logGroup: apiLogs,
      environment: {
        APP_ENV: 'prod',
        PUBLIC_ORIGIN: PUBLIC_ORIGIN_PROD,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    const reaperLogs = new logs.LogGroup(this, 'ReaperLogs', {
      logGroupName: `/aws/lambda/${REAPER_FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const reaper = new lambda.Function(this, 'Reaper', {
      functionName: REAPER_FUNCTION_NAME,
      code: apiCode,
      handler: 'reaper.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      logGroup: reaperLogs,
      environment: {
        APP_ENV: 'prod',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // IAM (docs/control-plane.md §7) — exact statements, nothing more.
    const instanceRoleArn = `arn:aws:iam::${ACCOUNT_ID}:role/${INSTANCE_ROLE_NAME}`;
    const gameInstanceArn = `arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}:instance/*`;
    const gameVolumeArn = `arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}:volume/*`;

    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RunInstancesResources',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:RunInstances'],
        resources: [
          `arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}:launch-template/*`,
          `arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}:subnet/*`,
          `arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}:security-group/*`,
          `arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}:network-interface/*`,
          // The AMI is Canonical's public Ubuntu image, so its IAM ARN has an EMPTY account
          // field (`arn:aws:ec2:us-west-2::image/ami-...`). An account-qualified `image/*`
          // matches nothing and RunInstances fails with UnauthorizedOperation naming exactly
          // this resource (measured, first boot; docs/_first-boot-notes.md round 1).
          `arn:aws:ec2:${GAME_REGION}::image/*`,
        ],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RunInstancesTaggedResources',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:RunInstances'],
        resources: [gameInstanceArn, gameVolumeArn],
        conditions: {
          StringEquals: { 'aws:RequestTag/project': PROJECT, 'aws:RequestTag/role': 'game' },
          'ForAllValues:StringEquals': { 'aws:TagKeys': ['project', 'role', 'sessionId', 'Name'] },
        },
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CreateTagsOnLaunch',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:CreateTags'],
        resources: [gameInstanceArn, gameVolumeArn],
        conditions: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PassInstanceRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [instanceRoleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DescribeEc2',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:DescribeInstances', 'ec2:DescribeSubnets', 'ec2:DescribeVpcs'],
        resources: ['*'],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TableAccess',
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [table.tableArn],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadSecrets',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${CONTROL_REGION}:${ACCOUNT_ID}:parameter${PARAM_USERS}`,
          `arn:aws:ssm:${CONTROL_REGION}:${ACCOUNT_ID}:parameter${PARAM_SESSION_SECRET}`,
          `arn:aws:ssm:${GAME_REGION}:${ACCOUNT_ID}:parameter${PARAM_CLUSTER_PASSWORD}`,
        ],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DecryptSecretsControlRegion',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${CONTROL_REGION}:${ACCOUNT_ID}:key/*`],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${CONTROL_REGION}.amazonaws.com` } },
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DecryptSecretsGameRegion',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${GAME_REGION}:${ACCOUNT_ID}:key/*`],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${GAME_REGION}.amazonaws.com` } },
      }),
    );

    reaper.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DescribeInstances',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );
    reaper.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TerminateTaggedInstances',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:TerminateInstances'],
        resources: [gameInstanceArn],
        conditions: { StringEquals: { 'ec2:ResourceTag/project': PROJECT } },
      }),
    );
    reaper.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TableAccess',
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
      }),
    );

    // 4.3 Function URL, CloudFront, OAC. Copied from the verified spike
    // docs/spikes/cloudfront-oac-lambda-url.md.
    const fnUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }); // never NONE
    const apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl);

    const site = new s3.Bucket(this, 'Site', {
      bucketName: SITE_BUCKET,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // no autoDeleteObjects anywhere
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: 'dst-server-manager-security',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: SPA_CSP, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
        },
      },
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
    });
    const cert = new acm.Certificate(this, 'Cert', {
      domainName: DOMAIN_NAME,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const dist = new cloudfront.Distribution(this, 'Dist', {
      comment: PROJECT,
      domainNames: [DOMAIN_NAME],
      certificate: cert,
      defaultRootObject: 'index.html',
      enableIpv6: true, // required for the AAAA alias
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      // No errorResponses: the SPA has no router (decisions §4), and custom error responses
      // apply to every behaviour, which would turn the API's diagnostic 403s into HTML 200s.
    });

    // REQUIRED (AWS "dual auth", Oct 2025). withOriginAccessControl() grants only
    // lambda:InvokeFunctionUrl; without this EVERY request is 403 AccessDeniedException.
    api.addPermission('OacInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: dist.distributionArn,
    });

    // 4.4 DNS. No new HostedZone anywhere: the zone serves other production sites. The stack owns
    // exactly two Route 53 record sets; ACM writes and removes its own validation CNAME.
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(dist));
    new route53.ARecord(this, 'ARecord', { zone, recordName: DOMAIN_NAME, target });
    new route53.AaaaRecord(this, 'AaaaRecord', { zone, recordName: DOMAIN_NAME, target });

    // 4.5 Site deployment. prune: false on both — two deployments share one bucket with no
    // destinationKeyPrefix, so a pruning deployment would delete the other's files every deploy.
    new s3deploy.BucketDeployment(this, 'SiteAssets', {
      sources: [s3deploy.Source.asset(props.webDistPath, { exclude: ['index.html'] })],
      destinationBucket: site,
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
    });
    new s3deploy.BucketDeployment(this, 'SiteIndex', {
      sources: [s3deploy.Source.asset(props.webDistPath, { exclude: ['*', '!index.html'] })],
      destinationBucket: site,
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('no-cache, no-store, must-revalidate')],
      distribution: dist,
      distributionPaths: ['/', '/index.html'],
    });

    // 4.6 Reaper schedule.
    new events.Rule(this, 'ReaperSchedule', {
      ruleName: REAPER_FUNCTION_NAME,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(reaper)], // no `event` override
    });

    // 4.7 Budget and SNS.
    const topic = new sns.Topic(this, 'BudgetTopic', {
      topicName: 'dst-server-manager-budget',
      displayName: 'dst-server-manager budget alerts',
    });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBudgetsPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['SNS:Publish'],
        resources: [topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': ACCOUNT_ID },
          ArnLike: { 'aws:SourceArn': `arn:aws:budgets::${ACCOUNT_ID}:budget/*` },
        },
      }),
    );

    const note = (notificationType: string, threshold: number) => ({
      notification: {
        notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'SNS', address: topic.topicArn }],
    });

    if (props.budgetEnabled) {
      new budgets.CfnBudget(this, 'Monthly', {
        budget: {
          budgetName: 'dst-server-manager-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: 5, unit: 'USD' },
          costFilters: { TagKeyValue: [`user:project$${PROJECT}`] },
        },
        notificationsWithSubscribers: [
          note('ACTUAL', 50),
          note('ACTUAL', 100),
          note('FORECASTED', 100),
        ],
      });
    }
  }
}
