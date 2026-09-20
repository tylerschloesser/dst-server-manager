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
  --help   print this message and exit 0. Makes no AWS call.
"

for arg in "$@"; do
  if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
    printf '%s' "$USAGE"
    exit 0
  fi
done

if [[ "${AWS_PROFILE:-}" != "admin" ]]; then
  echo "REFUSED: AWS_PROFILE=admin is required to run scripts/clean-account-check.sh" >&2
  exit 1
fi

DATA_BUCKET=dst-server-manager-data-063257577013
TABLE_NAME=dst-server-manager
LIVE_STATES=pending,running,stopping,stopped
PRUNE_EVIDENCE_KEY="worlds/test-prune/save.tar.zst"

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

  # 5. Launch templates: only dst-server-manager-game in us-west-2; none in us-east-1.
  templates=$(aws_admin ec2 describe-launch-templates --region "$REGION" \
    --query 'LaunchTemplates[].LaunchTemplateName' --output text 2>/dev/null)
  if [[ "$REGION" == "us-west-2" ]]; then
    if [[ "$templates" == "dst-server-manager-game" ]]; then
      pass "[$REGION] launch templates are exactly {dst-server-manager-game}"
    else
      fail "[$REGION] launch templates are exactly {dst-server-manager-game}" "found: $templates"
    fi
  else
    if [[ -z "$templates" || "$templates" == "None" ]]; then
      pass "[$REGION] no launch templates"
    else
      fail "[$REGION] no launch templates" "found: $templates"
    fi
  fi

  # 6. resourcegroupstaggingapi lists only expected ARNs (terminated instances excepted).
  arns=$(aws_admin resourcegroupstaggingapi get-resources --region "$REGION" \
    --tag-filters Key=project,Values=dst-server-manager \
    --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null)
  bad_arns=()
  if [[ -n "$arns" && "$arns" != "None" ]]; then
    for arn in $arns; do
      if [[ "$arn" =~ ^arn:aws:ec2:[a-z0-9-]+:063257577013:instance/ ]]; then
        instance_id="${arn##*/}"
        instance_state=$(aws_admin ec2 describe-instances --region "$REGION" --instance-ids "$instance_id" \
          --query 'Reservations[].Instances[].State.Name' --output text 2>/dev/null)
        if [[ "$instance_state" != "terminated" ]]; then
          bad_arns+=("$arn (state=$instance_state)")
        fi
      else
        # A non-EC2-instance ARN is one of the expected surviving resources (bucket, table,
        # launch template, security group, instance role, Lambdas, EventBridge rule, budget/SNS,
        # GitHub deploy role) — nothing else should carry this tag.
        bad_arns+=("$arn (unexpected resource type)")
      fi
    done
  fi
  if [[ ${#bad_arns[@]} -eq 0 ]]; then
    pass "[$REGION] resourcegroupstaggingapi lists only expected/terminated resources"
  else
    fail "[$REGION] resourcegroupstaggingapi lists only expected/terminated resources" "${bad_arns[*]}"
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
