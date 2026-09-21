// Unit test for the check 6 allowlist of scripts/clean-account-check.sh (docs/testing.md §6).
// The allowlist is shell, so it is exercised through the script's `--classify-arns <region>` mode,
// which applies exactly the allowlist of check 6 to ARNs on stdin and makes no AWS call: the
// script answers both `--help` and `--classify-arns` before its AWS_PROFILE precondition
// (decisions §16.40), so this test runs offline with no profile, like every other unit test.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./clean-account-check.sh', import.meta.url));
const ACCOUNT = '063257577013';

function classify(region: string, arns: string[]): Record<string, string> {
  const result = spawnSync('bash', [SCRIPT, '--classify-arns', region], {
    input: `${arns.join('\n')}\n`,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const verdicts: Record<string, string> = {};
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const space = line.indexOf(' ');
    verdicts[line.slice(space + 1)] = line.slice(0, space);
  }
  return verdicts;
}

describe('clean-account-check --classify-arns', () => {
  it('accepts every expected us-east-1 resource', () => {
    const arns = [
      `arn:aws:s3:::dst-server-manager-site-${ACCOUNT}`,
      `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/dst-server-manager`,
      `arn:aws:lambda:us-east-1:${ACCOUNT}:function:dst-server-manager-api`,
      `arn:aws:lambda:us-east-1:${ACCOUNT}:function:dst-server-manager-reaper`,
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/lambda/dst-server-manager-api`,
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/lambda/dst-server-manager-reaper`,
      `arn:aws:events:us-east-1:${ACCOUNT}:rule/dst-server-manager-reaper`,
      `arn:aws:cloudfront::${ACCOUNT}:distribution/E3EXAMPLE0000`,
      `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/00000000-0000-0000-0000-000000000000`,
      `arn:aws:sns:us-east-1:${ACCOUNT}:dst-server-manager-budget`,
      `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/dst/users`,
      `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/dst/session-secret`,
      // decisions §16.16: the CDK BucketDeployment custom resource is expected, in either region.
      `arn:aws:lambda:us-east-1:${ACCOUNT}:function:DstWeb-CustomCDKBucketDeployment8693-abc`,
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/lambda/DstWeb-CustomCDKBucketDeployment8693-abc`,
    ];
    const verdicts = classify('us-east-1', arns);
    for (const arn of arns) expect(verdicts[arn], arn).toBe('expected');
  });

  it('accepts every expected us-west-2 resource', () => {
    const arns = [
      `arn:aws:s3:::dst-server-manager-data-${ACCOUNT}`,
      `arn:aws:ec2:us-west-2:${ACCOUNT}:launch-template/lt-00000000000000000`,
      `arn:aws:ec2:us-west-2:${ACCOUNT}:security-group/sg-00000000000000000`,
      `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/dst/klei-token`,
      `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/dst/cluster-password`,
      `arn:aws:lambda:us-west-2:${ACCOUNT}:function:DstGame-CustomCDKBucketDeployment8693-abc`,
      `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:/aws/lambda/DstGame-CustomCDKBucketDeployment8693-abc`,
      // A volume the tagging API still lists after delete-on-termination removed it; check 4 is
      // the source of truth and FAILs on any volume that actually still exists.
      `arn:aws:ec2:us-west-2:${ACCOUNT}:volume/vol-00000000000000000`,
    ];
    const verdicts = classify('us-west-2', arns);
    for (const arn of arns) expect(verdicts[arn], arn).toBe('expected');
  });

  it('rejects an ARN that matches nothing in the allowlist', () => {
    const arns = [
      `arn:aws:sqs:us-east-1:${ACCOUNT}:some-queue`,
      `arn:aws:rds:us-east-1:${ACCOUNT}:db:dst-server-manager`,
      `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:loadbalancer/app/dst/abc`,
      `arn:aws:lambda:us-east-1:${ACCOUNT}:function:dst-server-manager-something-else`,
      `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/dst/klei-token`,
    ];
    const verdicts = classify('us-east-1', arns);
    for (const arn of arns) expect(verdicts[arn], arn).toBe('unexpected');
  });

  it('is region-scoped: a us-west-2 resource is not expected in us-east-1, and vice versa', () => {
    const dataBucket = `arn:aws:s3:::dst-server-manager-data-${ACCOUNT}`;
    const siteBucket = `arn:aws:s3:::dst-server-manager-site-${ACCOUNT}`;
    const gameTemplate = `arn:aws:ec2:us-west-2:${ACCOUNT}:launch-template/lt-00000000000000000`;
    expect(classify('us-east-1', [dataBucket, gameTemplate])).toEqual({
      [dataBucket]: 'unexpected',
      [gameTemplate]: 'unexpected',
    });
    expect(classify('us-west-2', [siteBucket])).toEqual({ [siteBucket]: 'unexpected' });
  });

  it('defers an EC2 instance ARN to describe-instances rather than classifying it offline', () => {
    const arn = `arn:aws:ec2:us-west-2:${ACCOUNT}:instance/i-00000000000000000`;
    expect(classify('us-west-2', [arn])).toEqual({ [arn]: 'instance' });
  });

  it('answers --help with exit 0, no profile and no AWS call', () => {
    const result = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain('--classify-arns');
  });
});
