#!/bin/sh
set -eu

load_secret() {
  variable_name="$1"
  secret_file="$2"
  if [ -r "$secret_file" ]; then
    secret_value="$(cat "$secret_file")"
    if [ -n "$secret_value" ]; then
      export "$variable_name=$secret_value"
    fi
  fi
}

load_secret AGENT_GATEWAY_SECRET /run/secrets/agent_gateway_secret
load_secret CONFIG_ENCRYPTION_KEY /run/secrets/config_encryption_key
load_secret LOCAL_ADMIN_PASSWORD /run/secrets/local_admin_password
load_secret LANGSMITH_API_KEY /run/secrets/langsmith_api_key

exec "$@"
