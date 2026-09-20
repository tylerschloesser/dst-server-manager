#!/bin/bash
shutdown -h +780                                   # dead-man, first line (decisions §7.2)
exec > >(tee -a /var/log/dst-userdata.log) 2>&1
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BUCKET=__DATA_BUCKET__; REGION=__GAME_REGION__
mkdir -p /opt/dst/run /opt/dst/tmp /var/log/dst
printf 'DST_BUCKET=%s\nDST_REGION=%s\nDST_TABLE=%s\nDST_TABLE_REGION=%s\nDST_ROOT=/opt/dst\n' \
  "$BUCKET" "$REGION" __TABLE_NAME__ __CONTROL_REGION__ > /opt/dst/run/supervisor.env

dpkg --add-architecture i386
apt-get update -qq
# Do NOT also install amd64 libcurl4-gnutls-dev: not co-installable with the :i386 one, and
# dpkg then aborts the whole transaction leaving every package merely "unpacked" (spike §1).
apt-get install -y -qq \
    lib32gcc-s1 lib32stdc++6 libcurl4-gnutls-dev:i386 \
    ca-certificates curl tar unzip zstd xz-utils jq bc procps

curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /opt/dst/tmp/awscliv2.zip
unzip -q /opt/dst/tmp/awscliv2.zip -d /opt/dst/tmp && /opt/dst/tmp/aws/install >/dev/null

NODE_VERSION=__NODE_VERSION__; NODE_SHA256=__NODE_SHA256__
T="node-$NODE_VERSION-linux-x64.tar.xz"
if ! aws s3 cp "s3://$BUCKET/runtime-cache/$T" /opt/dst/tmp/node.tar.xz --region "$REGION" --no-progress; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$T" -o /opt/dst/tmp/node.tar.xz
    echo "$NODE_SHA256  /opt/dst/tmp/node.tar.xz" | sha256sum -c -
    aws s3 cp /opt/dst/tmp/node.tar.xz "s3://$BUCKET/runtime-cache/$T" \
        --region "$REGION" --no-progress || true          # cache fill is best-effort
fi
echo "$NODE_SHA256  /opt/dst/tmp/node.tar.xz" | sha256sum -c -   # verified on BOTH paths
mkdir -p /opt/node && tar -xJf /opt/dst/tmp/node.tar.xz -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node && rm -f /opt/dst/tmp/node.tar.xz

aws s3 sync "s3://$BUCKET/runtime/" /opt/dst/runtime/ --region "$REGION" --delete --no-progress
bash /opt/dst/runtime/install.sh
systemctl start dst-supervisor.service
