// DstGame (us-west-2): data bucket, supervisor runtime bundle, security group, instance role,
// launch template. No application Lambdas here — the BucketDeployment custom-resource Lambda is
// expected plumbing (decisions §16.16). docs/infra.md §3.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import {
  ACCOUNT_ID,
  CAVES_PORT,
  CONTROL_REGION,
  DATA_BUCKET,
  GAME_REGION,
  HOSTED_ZONE_ID,
  INSTANCE_NAME_TAG,
  INSTANCE_ROLE_NAME,
  INSTANCE_TYPE,
  JOIN_HOSTNAME,
  LAUNCH_TEMPLATE_NAME,
  MASTER_PORT,
  PARAM_CLUSTER_PASSWORD,
  PARAM_KLEI_TOKEN,
  SECURITY_GROUP_NAME,
  TABLE_NAME,
} from '@dst/shared';
import { readNodeEnv } from './read-node-env';

export interface DstGameStackProps extends cdk.StackProps {
  /** Staged runtime bundle deployed to s3://<data>/runtime/ (docs/game-server.md §11). */
  supervisorBundlePath: string;
  /** The user-data script; `node.env` is read from the same directory (§1.1, §16.38). */
  userDataPath: string;
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
  }
}
