#!/bin/sh
set -eu

secret_file=/run/secrets/agent_gateway_secret
if [ ! -r "$secret_file" ]; then
  echo "missing agent gateway secret" >&2
  exit 1
fi

AGENT_GATEWAY_SECRET="$(cat "$secret_file")"
if [ -z "$AGENT_GATEWAY_SECRET" ]; then
  echo "empty agent gateway secret" >&2
  exit 1
fi
export AGENT_GATEWAY_SECRET

envsubst '${AGENT_GATEWAY_SECRET}' \
  < /etc/nginx/templates/naibaji.conf.template \
  > /etc/nginx/conf.d/default.conf

exec "$@"
