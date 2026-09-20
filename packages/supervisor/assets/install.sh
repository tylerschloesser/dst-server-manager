#!/bin/bash
# /opt/dst/runtime/install.sh — root, idempotent (docs/game-server.md §3). Run by user-data after
# `aws s3 sync s3://<bucket>/runtime/ /opt/dst/runtime/`. Creates the `dst` system user and the
# on-disk layout (docs/game-server.md §2), installs `runtime/bin/*` and `runtime/systemd/*.service`,
# and reloads systemd. It enables and starts nothing — `dst-supervisor.service` is started
# explicitly by user-data's last line, and it is the supervisor, not this script, that starts
# `dst-master`/`dst-caves`.
set -euo pipefail

DST_ROOT=/opt/dst
RUNTIME_DIR="$DST_ROOT/runtime"

id dst >/dev/null 2>&1 || \
    useradd --system --create-home --home-dir "$DST_ROOT" --shell /usr/sbin/nologin dst

mkdir -p \
    "$DST_ROOT/server" "$DST_ROOT/steamcmd" \
    "$DST_ROOT/klei/DoNotStarveTogether" \
    "$DST_ROOT/run" "$DST_ROOT/tmp" \
    /var/log/dst
chown -R dst:dst "$DST_ROOT"

install -m 0755 "$RUNTIME_DIR"/bin/* /usr/local/bin/
install -m 0644 "$RUNTIME_DIR"/systemd/*.service /etc/systemd/system/

systemctl daemon-reload
