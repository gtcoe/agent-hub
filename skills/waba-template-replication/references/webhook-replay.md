# WABA Webhook Replay And Troubleshooting

Use this reference when staging templates are stuck in `PENDING`, when replicating prod templates to staging, or when templates are rejected.

## Webhook Replay For Staging

Meta webhooks land only on prod. For staging templates stuck in `PENDING`:

1. Search prod OpenSearch index `app-prod-en-comm-<YYYY.MM.DD>` on the enterprise cluster.
2. Filter for:
   - `msg: access-log`
   - `request-path: /api/comm/public/waba/event`
   - the staging WABA ID
3. Extract `requestBody` JSON.
4. Replay it to staging:

```text
POST https://api.stage4.dotnu.co/api/comm/public/waba/event
```

Two useful webhook event types:

- `message_template_status_update`: sets `template_status`.
- `template_category_update`: sets `approved_category`.

## Rejected Templates

If template status is `REJECTED` with `INVALID_FORMAT`, fix `components` before recreating.

Common issue:

```text
Bad:  "text": "Hi {brand_name}!" with "variables": ["1","2","3"]
Good: "text": "Hi {{2}}!"        with "variables": ["1","2","3","4"]
```

Always use Meta-style numbered placeholders in body text unless the existing approved template intentionally uses a special literal variable such as `{{POS_DEAL}}`.

## Prod-To-Stage Replication

When replicating instead of fresh creation:

1. Pull prod `components`, `sample_text`, category, and language from `commDB.meta_waba_templates`.
2. Create the same template in staging through `POST /api/comm/public/v1/create/custom/waba/template`.
3. Verify staging row exists in `commDB.meta_waba_templates`.
4. Replay prod webhook payloads if staging remains `PENDING`.
5. Upsert loyalty or automation config only after staging template IDs are available.
