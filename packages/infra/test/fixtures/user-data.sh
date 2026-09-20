#!/bin/bash
# Fixture user-data: carries the same __PLACEHOLDERS__ as the real script (docs/infra.md §7) so
# the substitution in lib/game-stack.ts is exercised by tests. Not deployed anywhere.
set -euo pipefail

DATA_BUCKET="__DATA_BUCKET__"
GAME_REGION="__GAME_REGION__"
TABLE_NAME="__TABLE_NAME__"
CONTROL_REGION="__CONTROL_REGION__"
NODE_VERSION="__NODE_VERSION__"
NODE_SHA256="__NODE_SHA256__"

echo "fixture user-data: $DATA_BUCKET $GAME_REGION $TABLE_NAME $CONTROL_REGION $NODE_VERSION $NODE_SHA256"
