// DstGame (us-west-2): data bucket, supervisor runtime bundle, security group, instance role,
// launch template, and ONE application Lambda: the session digest (docs/infra.md §3.7), triggered
// by each session's manifest.json upload. The BucketDeployment and bucket-notifications
// custom-resource Lambdas are expected plumbing (decisions §16.16). docs/infra.md §3.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';
import {
  ACCOUNT_ID,
  CAVES_PORT,
  CONTROL_REGION,
  DATA_BUCKET,
  DIGEST_DIR,
  DIGEST_FUNCTION_NAME,
  GAME_REGION,
  HOSTED_ZONE_ID,
  INSTANCE_NAME_TAG,
  INSTANCE_ROLE_NAME,
  INSTANCE_TYPE,
  JOIN_HOSTNAME,
  LAUNCH_TEMPLATE_NAME,
  MASTER_PORT,
  NOTE_PK,
  PARAM_ANTHROPIC_API_KEY,
  PARAM_CLUSTER_PASSWORD,
  PARAM_KLEI_TOKEN,
  SECURITY_GROUP_NAME,
  SESSIONS_PREFIX,
  TABLE_NAME,
} from '@dst/shared';
import { readNodeEnv } from './read-node-env';

export interface DstGameStackProps extends cdk.StackProps {
  /** Staged runtime bundle deployed to s3://<data>/runtime/ (docs/game-server.md §11). */
  supervisorBundlePath: string;
  /** The user-data script; `node.env` is read from the same directory (§1.1, §16.38). */
  userDataPath: string;
  /** `@dst/recap`'s esbuild output: `digest.js` + `glue.wasm` + a CJS `package.json` (§3.7). */
  digestBundlePath: string;
}

export class DstGameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DstGameStackProps) {
    super(scope, id, props);

    // 3.1 Data bucket.
    const data = new s3.Bucket(this, 'Data', {
      bucketName: DATA_BUCKET,
      versioned: true,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // NO autoDeleteObjects — it provisions a Lambda whose only job is deleting this data.
      lifecycleRules: [
        {
          id: 'worlds-noncurrent',
          prefix: 'worlds/',
          enabled: true,
          expiredObjectDeleteMarker: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
          noncurrentVersionsToRetain: 10,
        },
        {
          id: 'inflight-noncurrent',
          prefix: 'inflight/',
          enabled: true,
          expiredObjectDeleteMarker: true,
          noncurrentVersionExpiration: cdk.Duration.days(7),
          noncurrentVersionsToRetain: 3,
        },
        // decisions §16.19: bucket-wide, aborts incomplete MPUs only, expires no object.
        {
          id: 'abort-mpu',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });
    data.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyDeleteOutsideScratchPrefixes',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
        notResources: [
          `${data.bucketArn}/runtime/*`,
          `${data.bucketArn}/runtime-cache/*`,
          `${data.bucketArn}/binaries/*`,
          `${data.bucketArn}/worlds/test-*`,
          `${data.bucketArn}/inflight/test-*`,
          `${data.bucketArn}/sessions/test-*`,
        ],
      }),
    );

    // 3.2 Supervisor runtime bundle.
    new s3deploy.BucketDeployment(this, 'Runtime', {
      sources: [s3deploy.Source.asset(props.supervisorBundlePath)],
      destinationBucket: data,
      destinationKeyPrefix: 'runtime',
      prune: true,
      retainOnDelete: true,
      memoryLimit: 512,
    });

    // 3.3 Default VPC lookup (context cached in cdk.context.json, §3.3).
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // 3.4 Security group: exactly one ingress rule, no SSH, no TCP.
    const sg = new ec2.SecurityGroup(this, 'GameSg', {
      vpc,
      securityGroupName: SECURITY_GROUP_NAME,
      description: 'DST shards: UDP 10998 (Caves) and 10999 (Master)',
      allowAllOutbound: true,
    });
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udpRange(CAVES_PORT, MASTER_PORT),
      'DST Master/Caves',
    );

    // 3.5 Instance role and profile.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      roleName: INSTANCE_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    const tableArn = `arn:aws:dynamodb:${CONTROL_REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}`;

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadRuntimeAndBinaries',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [
          `${data.bucketArn}/runtime/*`,
          `${data.bucketArn}/runtime-cache/*`,
          `${data.bucketArn}/binaries/*`,
        ],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSaves',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [`${data.bucketArn}/worlds/*`],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteSavesSessionsAndCaches',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [
          `${data.bucketArn}/worlds/*`,
          `${data.bucketArn}/inflight/*`,
          `${data.bucketArn}/sessions/*`,
          `${data.bucketArn}/binaries/*`,
          `${data.bucketArn}/runtime-cache/*`,
        ],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListDataPrefixes',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [data.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': [
              'runtime/*',
              'runtime-cache/*',
              'binaries/*',
              'worlds/*',
              'inflight/*',
              'sessions/*',
            ],
          },
        },
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'State',
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [tableArn],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Secrets',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${GAME_REGION}:${ACCOUNT_ID}:parameter${PARAM_KLEI_TOKEN}`,
          `arn:aws:ssm:${GAME_REGION}:${ACCOUNT_ID}:parameter${PARAM_CLUSTER_PASSWORD}`,
        ],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptSecrets',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${GAME_REGION}.amazonaws.com` } },
      }),
    );
    // The stable join name (docs/decisions.md §17, docs/infra.md §4.4). `ChangeResourceRecordSets`
    // takes only a hosted-zone ARN as its resource, and this zone serves other production sites —
    // so the two request-level condition keys are what make "this project may only touch its own
    // record" an IAM fact rather than a convention. The instance is the least-trusted component
    // here and it cannot rewrite `dst.ty.ler.dev` or anything else in the zone. `ForAllValues:`
    // matters: a change batch is a set, and without it a batch carrying this name PLUS another
    // would be allowed. The name is the NORMALIZED form — lowercase, no trailing dot.
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'JoinDnsRecord',
        effect: iam.Effect.ALLOW,
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:aws:route53:::hostedzone/${HOSTED_ZONE_ID}`],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': [JOIN_HOSTNAME],
            'route53:ChangeResourceRecordSetsRecordTypes': ['A'],
          },
        },
      }),
    );

    // 3.6 Launch template.
    // Placeholder names match the @dst/shared constant names one-for-one (docs/game-server.md §3).
    const node = readNodeEnv(path.join(path.dirname(props.userDataPath), 'node.env'));
    const userData = ec2.UserData.custom(
      fs
        .readFileSync(props.userDataPath, 'utf8')
        .replaceAll('__DATA_BUCKET__', DATA_BUCKET)
        .replaceAll('__GAME_REGION__', GAME_REGION)
        .replaceAll('__TABLE_NAME__', TABLE_NAME)
        .replaceAll('__CONTROL_REGION__', CONTROL_REGION)
        .replaceAll('__NODE_VERSION__', node.version)
        .replaceAll('__NODE_SHA256__', node.sha256),
    );

    const lt = new ec2.LaunchTemplate(this, 'Game', {
      launchTemplateName: LAUNCH_TEMPLATE_NAME,
      instanceType: new ec2.InstanceType(INSTANCE_TYPE),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
        { os: ec2.OperatingSystemType.LINUX },
      ),
      blockDevices: [
        {
          deviceName: '/dev/sda1', // Canonical Ubuntu root device
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      role: instanceRole,
      securityGroup: sg,
      requireImdsv2: true,
      httpPutResponseHopLimit: 1,
      instanceMetadataTags: true,
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
      detailedMonitoring: false,
      userData,
    });
    cdk.Tags.of(lt).add('role', 'game');
    cdk.Tags.of(lt).add('Name', INSTANCE_NAME_TAG);
    // decisions §16.16: the template carries project + role + Name; RunInstances repeats all
    // three and adds sessionId. The template holds no sessionId tag.

    // 3.7 Session digest Lambda (docs/infra.md §3.7). Same shape as the API/reaper (decisions
    // §16.29): plain lambda.Function + Code.fromAsset of a directory @dst/recap already built — no
    // bundling inside CDK. NOT in a VPC: it needs egress to api.anthropic.com, which a Lambda
    // outside a VPC has for free and one inside the default VPC would need a NAT for (never).
    // No reserved concurrency: this account hosts other sites, and reserving any would come out of
    // the shared unreserved pool (deploy fails if that would drop below the account minimum).
    // Concurrency is naturally ~1 — one world runs at a time, one manifest per session.
    const digestLogs = new logs.LogGroup(this, 'DigestLogs', {
      logGroupName: `/aws/lambda/${DIGEST_FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const digest = new lambda.Function(this, 'Digest', {
      functionName: DIGEST_FUNCTION_NAME,
      code: lambda.Code.fromAsset(props.digestBundlePath),
      handler: 'digest.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Two ~4 MB Lua saves parsed in a WASM Lua VM (~160 MB RSS each); Lambda CPU scales with
      // memory, so the extra headroom is also speed.
      memorySize: 1536,
      // Parse ~5-10 s + one Anthropic call with its own 90 s timeout + S3 I/O.
      timeout: cdk.Duration.minutes(5),
      logGroup: digestLogs,
      // S3 invokes asynchronously; Lambda's default of 2 retries would re-bill the LLM call twice.
      retryAttempts: 1,
      environment: {
        APP_ENV: 'prod',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // Digest IAM — exact statements, nothing more. No s3:Delete*, no write outside
    // sessions/*/digest/*, no seed/ at all, and no ListBucketVersions (version ids come from the
    // session manifest's preStartVersionId/postStopVersionId).
    const digestPrefix = `${SESSIONS_PREFIX}*/${DIGEST_DIR}/*`; // sessions/*/digest/*
    digest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadSaveVersions',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [`${data.bucketArn}/worlds/*`],
      }),
    );
    digest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadSessions',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`${data.bucketArn}/${SESSIONS_PREFIX}*`],
      }),
    );
    digest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WriteDigest',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [`${data.bucketArn}/${digestPrefix}`],
      }),
    );
    digest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ListSessions',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [data.bucketArn],
        conditions: { StringLike: { 's3:prefix': [`${SESSIONS_PREFIX}*`] } },
      }),
    );
    // Human-managed and optional (like /dst/klei-token, never a CDK resource): without it the
    // digest still runs and marks the LLM summary unavailable.
    digest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadAnthropicKey',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${GAME_REGION}:${ACCOUNT_ID}:parameter${PARAM_ANTHROPIC_API_KEY}`],
      }),
    );
    digest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DecryptAnthropicKey',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${GAME_REGION}:${ACCOUNT_ID}:key/*`],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${GAME_REGION}.amazonaws.com` } },
      }),
    );
    // The per-world "next time" note (pk=NOTE, sk=<worldId>), cross-region by ARN. LeadingKeys
    // confines it to that partition: it cannot read the state item or the world registry.
    digest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadNote',
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [NOTE_PK] } },
      }),
    );

    // Trigger: the supervisor uploads manifest.json LAST, after every log file
    // (packages/supervisor/src/tasks/logsUpload.ts), so the logs exist when this fires. The
    // suffix keeps the digest's own writes under sessions/*/digest/* from re-triggering it.
    // CDK renders this as a Custom::S3BucketNotifications resource whose handler does a FULL
    // replace of the bucket's notification configuration (Managed: true, because this stack owns
    // the bucket) — correct only while this is the bucket's sole notification. docs/infra.md §3.7.
    data.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(digest), {
      prefix: SESSIONS_PREFIX,
      suffix: 'manifest.json',
    });
  }
}
