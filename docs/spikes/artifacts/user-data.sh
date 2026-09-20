#!/bin/bash
# DST spike user-data. MODE is substituted by the launcher: "cold" or "tarball".
# cold    = steamcmd full install of app 343050, save restored from the original zip
# tarball = binaries tar.zst + save tar.zst restored from S3, then steamcmd app_update
exec > >(tee -a /var/log/dst-userdata.log) 2>&1

# --- dead man's switch: nothing this spike creates may outlive 4 hours ---
shutdown -h +240

MODE=__MODE__
BUCKET=dst-spike-063257577013
REGION=us-west-2
DST_ROOT=/opt/dst
CLUSTER="$DST_ROOT/klei/DoNotStarveTogether/TylerNi2026"
TL=/var/log/dst-timeline.log
VALIDATE=__VALIDATE__

ts() { echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) $(awk '{print $1}' /proc/uptime) $*" >> "$TL"; }
ts t_userdata_start mode="$MODE"

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- packages ---
ts t_apt_start
dpkg --add-architecture i386
apt-get update -qq
# NOTE: do NOT also install the amd64 libcurl4-gnutls-dev - it is not co-installable with
# the :i386 one and dpkg aborts the whole transaction (measured on boot 1).
apt-get install -y -qq \
    lib32gcc-s1 lib32stdc++6 libcurl4-gnutls-dev:i386 \
    ca-certificates curl tar unzip zstd jq bc procps
ts t_apt_done

ts t_awscli_start
curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install >/dev/null
ts t_awscli_done

# ---------------------------------------------------------------- dst user ---
id dst >/dev/null 2>&1 || useradd --system --create-home --home-dir "$DST_ROOT" --shell /bin/bash dst
mkdir -p "$DST_ROOT/run" "$DST_ROOT/klei/DoNotStarveTogether" "$DST_ROOT/steamcmd"
chown -R dst:dst "$DST_ROOT"

# ------------------------------------------------------------- game binaries ---
ts t_binaries_start
if [ "$MODE" = "tarball" ]; then
    aws s3 cp "s3://$BUCKET/binaries/dst-binaries.tar.zst" /tmp/b.tar.zst --region "$REGION" --no-progress
    ts t_binaries_downloaded bytes=$(stat -c%s /tmp/b.tar.zst)
    tar -I zstd -xf /tmp/b.tar.zst -C "$DST_ROOT"
    chown -R dst:dst "$DST_ROOT/server" "$DST_ROOT/steamcmd"
    rm -f /tmp/b.tar.zst
    ts t_binaries_extracted
else
    runuser -u dst -- bash -c "cd $DST_ROOT/steamcmd && curl -sL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar zxf -"
    ts t_steamcmd_ready
fi

ts t_appupdate_start validate="$VALIDATE"
runuser -u dst -- bash -c "cd $DST_ROOT/steamcmd && HOME=$DST_ROOT ./steamcmd.sh +force_install_dir $DST_ROOT/server +login anonymous +app_update 343050 $VALIDATE +quit" \
    | tail -20
ts t_appupdate_done du_mb=$(du -sm "$DST_ROOT/server" | cut -f1)
ts t_binaries_done

# --------------------------------------------------------------------- save ---
ts t_save_start
if [ "$MODE" = "tarball" ]; then
    aws s3 cp "s3://$BUCKET/save/cluster.tar.zst" /tmp/c.tar.zst --region "$REGION" --no-progress
    ts t_save_downloaded bytes=$(stat -c%s /tmp/c.tar.zst)
    mkdir -p "$DST_ROOT/klei/DoNotStarveTogether"
    tar -I zstd -xf /tmp/c.tar.zst -C "$DST_ROOT/klei/DoNotStarveTogether"
    rm -f /tmp/c.tar.zst
else
    aws s3 cp "s3://$BUCKET/save/dst-tylerni2026.zip" /tmp/s.zip --region "$REGION" --no-progress
    rm -rf /tmp/sx && mkdir -p /tmp/sx
    unzip -q /tmp/s.zip -d /tmp/sx
    cp -a /tmp/sx/dst-tylerni2026/cluster/TylerNi2026 "$DST_ROOT/klei/DoNotStarveTogether/"
    rm -rf /tmp/sx /tmp/s.zip
    # ---- config edits required by the idle-detection design (on the COPY only) ----
    # MEASURED: none are actually needed for this save. The Caves [SHARD] id is NOT
    # pinned - the joinable line is "World <id>(Caves) is now connected", so anchoring on
    # the shard NAME removes the need to touch the save at all. The two asserts below are
    # no-ops on this save but are cheap insurance.
    grep -qiE '^[[:space:]]*console_enabled' "$CLUSTER/cluster.ini" \
        || sed -i '0,/^\[MISC\]/s//[MISC]\nconsole_enabled = true/' "$CLUSTER/cluster.ini"
    grep -qiE '^[[:space:]]*pause_when_empty' "$CLUSTER/cluster.ini" \
        || sed -i '0,/^\[GAMEPLAY\]/s//[GAMEPLAY]\npause_when_empty = true/' "$CLUSTER/cluster.ini"
fi
chmod 600 "$CLUSTER/cluster_token.txt"
chown -R dst:dst "$DST_ROOT/klei"
ts t_save_done

# ---------------------------------------------------------- systemd + start ---
__SCRIPTS__
ts t_units_written

systemctl daemon-reload
systemctl start dst-master.service dst-caves.service
ts t_shards_started

# ------------------------------------------------------- joinable detection ---
nohup /usr/local/bin/dst-joinable-watch >/dev/null 2>&1 &
ts t_userdata_done
