# Staging API Access

## Base URL

```
https://api.stage4.dotnu.co
```

All marketing service routes are prefixed with `/api/marketing`.

## Admin Login

Tokens expire on deployment. Obtain a fresh token with:

```bash
set -a
source .agent-hub/secrets/.env
set +a

curl -s 'https://api.stage4.dotnu.co/api/uams/login' \
  -H 'content-type: text/plain;charset=UTF-8' \
  --data-raw "{\"username\":\"$STAGING_ADMIN_USERNAME\",\"password\":\"$STAGING_ADMIN_PASSWORD\",\"isAdmin\":true,\"usertype\":\"admin\"}" \
  | jq -r '.token'
```

Credentials are in `.agent-hub/secrets/.env`. Use the returned token as `Authorization: Bearer <token>` in subsequent requests.

## Merchant Login For Authenticated E2E

Most marketing `/public` and CRM dashboard routes derive `merchant_id` from the merchant JWT. When E2E testing a merchant-specific flow, obtain a merchant token through the same UAMS login endpoint with a non-admin merchant account:

```bash
MERCHANT_ID=12109 # Also configured: 20166
MERCHANT_USERNAME_VAR="STAGING_MERCHANT_${MERCHANT_ID}_USERNAME"
MERCHANT_PASSWORD_VAR="STAGING_MERCHANT_${MERCHANT_ID}_PASSWORD"
MERCHANT_USERNAME=$(printenv "$MERCHANT_USERNAME_VAR")
MERCHANT_PASSWORD=$(printenv "$MERCHANT_PASSWORD_VAR")

curl -s 'https://api.stage4.dotnu.co/api/uams/login' \
  -H 'content-type: text/plain;charset=UTF-8' \
  --data-raw "{\"username\":\"$MERCHANT_USERNAME\",\"password\":\"$MERCHANT_PASSWORD\",\"isAdmin\":false,\"usertype\":\"merchant\"}" \
  | jq -r '.token'
```

Use merchant credentials only from `.agent-hub/secrets/.env`, process environment, or credentials explicitly provided in the current chat. Do not write merchant passwords or tokens into repo files, generated agent config, shell history snippets, or test artifacts.

## Staging ClickHouse

- HTTP endpoint: see `STAGING_CLICKHOUSE_HOST_URL` in `.agent-hub/secrets/.env`
- Credentials: `STAGING_CLICKHOUSE_USER` / `STAGING_CLICKHOUSE_PASSWORD` from `.agent-hub/secrets/.env`
- Example: `curl -s "$STAGING_CLICKHOUSE_HOST_URL" -u "$STAGING_CLICKHOUSE_USER:$STAGING_CLICKHOUSE_PASSWORD" --data "SELECT 1"`
