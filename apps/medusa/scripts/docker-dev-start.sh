#!/bin/sh
set -eu

if [ ! -d node_modules/@medusajs ]; then
  npm install --no-audit --no-fund
fi

cd apps/backend

if [ "${RUN_MEDUSA_SETUP:-false}" = "true" ]; then
  node ../../node_modules/@medusajs/cli/cli.js db:setup \
    --db "${POSTGRES_DB:-medusa}" \
    --no-interactive \
    --execute-safe-links

  if [ -n "${MEDUSA_ADMIN_EMAIL:-}" ] && [ -n "${MEDUSA_ADMIN_PASSWORD:-}" ]; then
    node ../../node_modules/@medusajs/cli/cli.js user \
      -e "$MEDUSA_ADMIN_EMAIL" \
      -p "$MEDUSA_ADMIN_PASSWORD" || true
  fi
fi

node ../../node_modules/@medusajs/cli/cli.js develop
