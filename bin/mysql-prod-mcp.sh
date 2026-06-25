#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "${SCRIPT_DIR}/agent-tunnel.js" ensure prod-mysql

export MYSQL_HOST="127.0.0.1"
export MYSQL_PORT="${PROD_MYSQL_LOCAL_PORT:-33307}"
export MYSQL_USER="${PROD_MYSQL_USER:?PROD_MYSQL_USER is required}"
export MYSQL_PASS="${PROD_MYSQL_PASS:?PROD_MYSQL_PASS is required}"
export ALLOW_INSERT_OPERATION="false"
export ALLOW_UPDATE_OPERATION="false"
export ALLOW_DELETE_OPERATION="false"

exec "${NODE20_BIN:?NODE20_BIN is required}/mcp-server-mysql"
