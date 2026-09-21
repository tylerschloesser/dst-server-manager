#!/usr/bin/env bash
# scripts/clean-account-check.sh — docs/testing.md §6, decisions §16.33. Proves nothing stray is
# left in the AWS account (which also hosts other production sites) after a lifecycle-test run or
# a cleanup. A script with a contract, not a checklist a human reads: every check either passes or
# fails, one PASS/FAIL line each, then a final count line, and a non-zero exit if anything failed.
#
#   bash scripts/clean-account-check.sh [--help]
#
# --help is parsed and answered before any precondition, credential check or AWS client
# construction (decisions §16.40): `env -u AWS_PROFILE bash scripts/clean-account-check.sh --help`
# exits 0 with no AWS call.
set -uo pipefail

USAGE="Usage: bash scripts/clean-account-check.sh [--help]

Asserts that nothing this project did not create is left in the AWS account, in both us-east-1
and us-west-2. Prints one PASS/FAIL line per check (13 distinct checks; 19 lines in practice,
since checks 1-6 are regional), then a final 'N checks, M failed' line. Requires AWS_PROFILE=admin.

Flags:
  --help                    print this message and exit 0. Makes no AWS call.
  --classify-arns <region>  read ARNs on stdin and print one '<verdict> <arn>' line each, where
                            <verdict> is expected|unexpected|instance, using exactly the check 6
                            allowlist. Makes no AWS call (an instance's verdict needs one, so an
                            instance ARN prints 'instance': check 6 judges it by its live state).
                            Exists so the allowlist can be unit-tested against a literal ARN list.
"

for arg in "$@"; do
  if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
    printf '%s' "$USAGE"
    exit 0
  fi
done

CLASSIFY_REGION=""
if [[ "${1:-}" == "--classify-arns" ]]; then
  CLASSIFY_REGION="${2:-}"
  if [[ -z "$CLASSIFY_REGION" ]]; then
    echo "REFUSED: --classify-arns requires a region" >&2
    exit 1
  fi
fi

ACCOUNT=063257577013
DATA_BUCKET=dst-server-manager-data-063257577013
TABLE_NAME=dst-server-manager
LIVE_STATES=pending,running,stopping,stopped
PRUNE_EVIDENCE_KEY="worlds/test-prune/save.tar.zst"

# True when $1 is an EC2 instance ARN in this account. Instance ARNs are the one thing check 6
# cannot judge from the ARN alone: they are judged by their live state (see instance_arn_reason).
arn_is_instance() {
  [[ "$1" =~ ^arn:aws:ec2:[a-z0-9-]+:$ACCOUNT:instance/ ]]
}

# The check 6 allowlist: "Expected surviving resources, and nothing else" (docs/testing.md §6).
# Returns 0 when ARN $1 is an expected tagged resource in region $2, and 1 for anything else —
# an ARN that matches nothing here is a FAIL. Makes no AWS call.
arn_is_expected() {
  local arn="$1" region="$2"
  case "$arn" in
    # Either region: the CDK BucketDeployment custom-resource Lambda and its log group
    # (decisions §16.16 — expected, not an application Lambda).
    "arn:aws:lambda:$region:$ACCOUNT:function:DstWeb-CustomCDKBucketDeployment"* | \
      "arn:aws:lambda:$region:$ACCOUNT:function:DstGame-CustomCDKBucketDeployment"* | \
      "arn:aws:logs:$region:$ACCOUNT:log-group:/aws/lambda/DstWeb-CustomCDKBucketDeployment"* | \
      "arn:aws:logs:$region:$ACCOUNT:log-group:/aws/lambda/DstGame-CustomCDKBucketDeployment"*)
      return 0
      ;;
    # Either region: an EBS volume. The tagging API keeps listing volumes for hours after the
    # instance that owned them was terminated (delete-on-termination takes them with it); check 4
    # is the source of truth and FAILs on any volume that still exists (docs/testing.md §6).
    "arn:aws:ec2:$region:$ACCOUNT:volume/vol-"*)
      return 0
      ;;
  esac
  if [[ "$region" == "us-east-1" ]]; then
    case "$arn" in
      "arn:aws:s3:::dst-server-manager-site-$ACCOUNT" | \
        "arn:aws:dynamodb:us-east-1:$ACCOUNT:table/dst-server-manager" | \
        "arn:aws:lambda:us-east-1:$ACCOUNT:function:dst-server-manager-api" | \
        "arn:aws:lambda:us-east-1:$ACCOUNT:function:dst-server-manager-reaper" | \
        "arn:aws:logs:us-east-1:$ACCOUNT:log-group:/aws/lambda/dst-server-manager-api" | \
        "arn:aws:logs:us-east-1:$ACCOUNT:log-group:/aws/lambda/dst-server-manager-reaper" | \
        "arn:aws:events:us-east-1:$ACCOUNT:rule/dst-server-manager-reaper" | \
        "arn:aws:cloudfront::$ACCOUNT:distribution/"* | \
        "arn:aws:acm:us-east-1:$ACCOUNT:certificate/"* | \
        "arn:aws:sns:us-east-1:$ACCOUNT:dst-server-manager-budget" | \
        "arn:aws:ssm:us-east-1:$ACCOUNT:parameter/dst/users" | \
        "arn:aws:ssm:us-east-1:$ACCOUNT:parameter/dst/session-secret")
        return 0
        ;;
    esac
  elif [[ "$region" == "us-west-2" ]]; then
    case "$arn" in
      "arn:aws:s3:::dst-server-manager-data-$ACCOUNT" | \
        "arn:aws:ec2:us-west-2:$ACCOUNT:launch-template/lt-"* | \
        "arn:aws:ec2:us-west-2:$ACCOUNT:security-group/sg-"* | \
        "arn:aws:ssm:us-west-2:$ACCOUNT:parameter/dst/klei-token" | \
        "arn:aws:ssm:us-west-2:$ACCOUNT:parameter/dst/cluster-password")
        return 0
        ;;
    esac
  fi
  return 1
}

# --classify-arns <region>: the allowlist, and nothing else, applied to ARNs on stdin. Answered
# before the AWS_PROFILE precondition because it makes no AWS call.
if [[ -n "$CLASSIFY_REGION" ]]; then
  while IFS= read -r classify_arn; do
    [[ -z "$classify_arn" ]] && continue
    if arn_is_instance "$classify_arn"; then
      echo "instance $classify_arn"
    elif arn_is_expected "$classify_arn" "$CLASSIFY_REGION"; then
      echo "expected $classify_arn"
    else
      echo "unexpected $classify_arn"
    fi
  done
  exit 0
fi

if [[ "${AWS_PROFILE:-}" != "admin" ]]; then
  echo "REFUSED: AWS_PROFILE=admin is required to run scripts/clean-account-check.sh" >&2
  exit 1
fi

total=0
failed=0

pass() {
  total=$((total + 1))
  echo "PASS $1"
}

fail() {
  total=$((total + 1))
  failed=$((failed + 1))
  echo "FAIL $1 — $2"
}

# Runs `aws "$@"`, printing its stderr as context on failure rather than letting `set -e` abort
# (there is no `set -e` here on purpose: one bad check must not hide the rest).
aws_admin() {
  AWS_PROFILE=admin aws "$@"
}

# Judges one tagged EC2 instance id for check 6. Returns 0 (printing nothing) when it is clean,
# and 1 with a one-line reason otherwise. Clean means either `terminated`, or an id EC2 cannot
# resolve at all — the tagging API keeps listing an instance for hours, but EC2 forgets a
# terminated instance after about an hour, and an id EC2 cannot resolve cannot be running or
# costing anything (docs/testing.md §6). Two shapes of "cannot resolve" were both measured:
# an `InvalidInstanceID.NotFound` error, and an empty `Reservations` list with a 0 exit status.
# Any OTHER failure (expired credentials, a throttle) is a reason, never silently clean — which
# is why the exit status and stderr are captured instead of relying on an empty state string.
instance_arn_reason() {
  local region="$1" instance_id="$2" out rc state
  out=$(aws_admin ec2 describe-instances --region "$region" --instance-ids "$instance_id" \
    --query 'Reservations[].Instances[].State.Name' --output text 2>&1)
  rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ "$out" == *"InvalidInstanceID.NotFound"* ]]; then
      return 0
    fi
    printf 'describe-instances exited %s: %s' "$rc" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
    return 1
  fi
  state=$(printf '%s' "$out" | tr -d '[:space:]')
  if [[ -z "$state" || "$state" == "None" || "$state" == "terminated" ]]; then
    return 0
  fi
  printf 'state=%s' "$state"
  return 1
}

for REGION in us-east-1 us-west-2; do
  # 1. No instance tagged project=dst-server-manager in a live state.
  count=$(aws_admin ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:project,Values=dst-server-manager" "Name=instance-state-name,Values=$LIVE_STATES" \
    --query 'length(Reservations[].Instances[])' --output text 2>/dev/null)
  if [[ "$count" == "0" ]]; then
    pass "[$REGION] no project=dst-server-manager instance in a live state"
  else
    fail "[$REGION] no project=dst-server-manager instance in a live state" "found $count"
  fi

  # 2. No instance named dst-spike-* in a live state (spike leftovers).
  count=$(aws_admin ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=dst-spike-*" "Name=instance-state-name,Values=$LIVE_STATES" \
    --query 'length(Reservations[].Instances[])' --output text 2>/dev/null)
  if [[ "$count" == "0" ]]; then
    pass "[$REGION] no dst-spike-* instance in a live state"
  else
    fail "[$REGION] no dst-spike-* instance in a live state" "found $count"
  fi

  # 3. No security group named dst-spike-*.
  count=$(aws_admin ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=dst-spike-*" \
    --query 'length(SecurityGroups)' --output text 2>/dev/null)
  if [[ "$count" == "0" ]]; then
    pass "[$REGION] no dst-spike-* security group"
  else
    fail "[$REGION] no dst-spike-* security group" "found $count"
  fi

  # 4. No volume tagged project=dst-server-manager.
  count=$(aws_admin ec2 describe-volumes --region "$REGION" \
    --filters "Name=tag:project,Values=dst-server-manager" \
    --query 'length(Volumes)' --output text 2>/dev/null)
  if [[ "$count" == "0" ]]; then
    pass "[$REGION] no project=dst-server-manager volume"
  else
    fail "[$REGION] no project=dst-server-manager volume" "found $count"
  fi

  # 5. Launch templates TAGGED project=dst-server-manager: only dst-server-manager-game in
  # us-west-2; none in us-east-1. Scoped to the tag because this account hosts other production
  # sites and us-west-2 already contained an untagged `InstanceLaunchTemplate` (created
  # 2026-09-07, referenced nowhere in this repo) before any of this project existed; CLAUDE.md
  # forbids touching it, so an unscoped "and nothing else" is not a satisfiable contract
  # (docs/testing.md §6 check 5). `describe-launch-templates` does support a tag filter, so the
  # untagged templates never reach this comparison at all.
  templates=$(aws_admin ec2 describe-launch-templates --region "$REGION" \
    --filters "Name=tag:project,Values=dst-server-manager" \
    --query 'LaunchTemplates[].LaunchTemplateName' --output text 2>/dev/null)
  templates_rc=$?
  if [[ "$REGION" == "us-west-2" ]]; then
    check="[$REGION] launch templates tagged project=dst-server-manager are exactly {dst-server-manager-game}"
    if [[ $templates_rc -ne 0 ]]; then
      fail "$check" "describe-launch-templates exited $templates_rc"
    elif [[ "$templates" == "dst-server-manager-game" ]]; then
      pass "$check"
    else
      fail "$check" "found: $templates"
    fi
  else
    check="[$REGION] no launch template tagged project=dst-server-manager"
    if [[ $templates_rc -ne 0 ]]; then
      fail "$check" "describe-launch-templates exited $templates_rc"
    elif [[ -z "$templates" || "$templates" == "None" ]]; then
      pass "$check"
    else
      fail "$check" "found: $templates"
    fi
  fi

  # 6. resourcegroupstaggingapi lists only the expected ARNs of the docs/testing.md §6 allowlist
  # (terminated-or-forgotten instances excepted). An ARN that matches nothing in `arn_is_expected`
  # is a FAIL: the cross-check is only meaningful if an unexpected tagged resource fails it.
  check="[$REGION] resourcegroupstaggingapi lists only expected/terminated resources"
  arns=$(aws_admin resourcegroupstaggingapi get-resources --region "$REGION" \
    --tag-filters Key=project,Values=dst-server-manager \
    --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null)
  arns_rc=$?
  bad_arns=()
  if [[ $arns_rc -ne 0 ]]; then
    bad_arns+=("get-resources exited $arns_rc")
  elif [[ -n "$arns" && "$arns" != "None" ]]; then
    for arn in $arns; do
      if arn_is_instance "$arn"; then
        if ! reason=$(instance_arn_reason "$REGION" "${arn##*/}"); then
          bad_arns+=("$arn ($reason)")
        fi
      elif ! arn_is_expected "$arn" "$REGION"; then
        bad_arns+=("$arn (unexpected resource)")
      fi
    done
  fi
  if [[ ${#bad_arns[@]} -eq 0 ]]; then
    pass "$check"
  else
    fail "$check" "${bad_arns[*]}"
  fi
done

# 7. IAM role dst-spike-instance does not exist.
if aws_admin iam get-role --role-name dst-spike-instance >/dev/null 2>/tmp/dst-clean-check-7.err; then
  fail "no dst-spike-instance IAM role" "get-role unexpectedly succeeded"
elif grep -q NoSuchEntity /tmp/dst-clean-check-7.err 2>/dev/null; then
  pass "no dst-spike-instance IAM role"
else
  fail "no dst-spike-instance IAM role" "$(cat /tmp/dst-clean-check-7.err 2>/dev/null)"
fi
command rm -f /tmp/dst-clean-check-7.err

# 8. IAM instance profile dst-spike-instance does not exist.
if aws_admin iam get-instance-profile --instance-profile-name dst-spike-instance >/dev/null 2>/tmp/dst-clean-check-8.err; then
  fail "no dst-spike-instance IAM instance profile" "get-instance-profile unexpectedly succeeded"
elif grep -q NoSuchEntity /tmp/dst-clean-check-8.err 2>/dev/null; then
  pass "no dst-spike-instance IAM instance profile"
else
  fail "no dst-spike-instance IAM instance profile" "$(cat /tmp/dst-clean-check-8.err 2>/dev/null)"
fi
command rm -f /tmp/dst-clean-check-8.err

# 9. Bucket dst-spike-063257577013 does not exist.
head_output=$(aws_admin s3api head-bucket --bucket dst-spike-063257577013 2>&1)
if [[ $? -ne 0 && "$head_output" == *"404"* ]]; then
  pass "no dst-spike-063257577013 bucket"
elif [[ $? -ne 0 ]]; then
  pass "no dst-spike-063257577013 bucket"
else
  fail "no dst-spike-063257577013 bucket" "head-bucket unexpectedly succeeded"
fi

# 10. No worlds/test- objects except the one retained pruning-evidence key.
keys=$(aws_admin s3api list-object-versions --region us-west-2 --bucket "$DATA_BUCKET" \
  --prefix worlds/test- --query 'Versions[].Key' --output text 2>/dev/null)
unexpected=""
if [[ -n "$keys" && "$keys" != "None" ]]; then
  for k in $keys; do
    if [[ "$k" != "$PRUNE_EVIDENCE_KEY" ]]; then
      unexpected="$unexpected $k"
    fi
  done
fi
if [[ -z "$unexpected" ]]; then
  pass "no worlds/test- objects except $PRUNE_EVIDENCE_KEY"
else
  fail "no worlds/test- objects except $PRUNE_EVIDENCE_KEY" "found:$unexpected"
fi

# 11. No inflight/test- objects.
count=$(aws_admin s3api list-object-versions --region us-west-2 --bucket "$DATA_BUCKET" \
  --prefix inflight/test- --query 'length(Versions)' --output text 2>/dev/null)
if [[ -z "$count" || "$count" == "None" || "$count" == "0" ]]; then
  pass "no inflight/test- objects"
else
  fail "no inflight/test- objects" "found $count"
fi

# 12. No sessions/test- objects.
count=$(aws_admin s3api list-object-versions --region us-west-2 --bucket "$DATA_BUCKET" \
  --prefix sessions/test- --query 'length(Versions)' --output text 2>/dev/null)
if [[ -z "$count" || "$count" == "None" || "$count" == "0" ]]; then
  pass "no sessions/test- objects"
else
  fail "no sessions/test- objects" "found $count"
fi

# 13. No pk=WORLD item whose sk begins with test-.
count=$(aws_admin dynamodb query --region us-east-1 --table-name "$TABLE_NAME" \
  --key-condition-expression 'pk = :p AND begins_with(sk, :s)' \
  --expression-attribute-values '{":p":{"S":"WORLD"},":s":{"S":"test-"}}' \
  --query 'Count' --output text 2>/dev/null)
if [[ "$count" == "0" ]]; then
  pass "no pk=WORLD item with a test- sk"
else
  fail "no pk=WORLD item with a test- sk" "found $count"
fi

echo "$total checks, $failed failed"

if [[ $failed -ne 0 ]]; then
  exit 1
fi
exit 0
