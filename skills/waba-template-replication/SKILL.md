---
name: waba-template-replication
description: Playbook for setting up WABA templates and loyalty or automation communication configs for a merchant. Use when asked to setup WABA templates, configure loyalty WABA, add WhatsApp templates, replicate WABA templates between prod and staging, insert loyalty program_comm_config, or configure marketing automation WhatsApp templates.
---

# WABA Template Replication

## Required Inputs

Always ask for these before taking action:

- Environment: `stage` or `prod`
- Merchant ID
- Program type: `point`, `visit`, or `automation`

Also ask for an admin JWT before calling the loyalty or marketing config upsert APIs. Do not invent or fetch an admin JWT unless the user explicitly asks you to use workspace credentials.

## Environment Map

| Env | API base | MCP DB |
| --- | --- | --- |
| prod | `https://api.dotpe.in` | `prod-mysql` |
| stage | `https://api.stage4.dotnu.co` | `staging-mysql` |

Use `commDB` for WABA tables, `loyaltyDB` for loyalty comm config, and `marketingDB` for automation comm config.

## Workflow

1. Confirm environment, merchant ID, program type, and whether this is fresh creation or prod-to-stage replication.
2. Check active approved WABA:

```sql
SELECT waba_id, status, account_review_status, merchant_id
FROM commDB.meta_waba_info
WHERE merchant_id = <merchant_id>
  AND status = 'A'
  AND account_review_status = 'APPROVED';
```

Stop if no row is returned. `CreateWabaTemplate` rejects WABA accounts that are not `status = 'A'` and `account_review_status = 'APPROVED'`.

3. Create templates through:

```text
POST {env_api}/api/comm/public/v1/create/custom/waba/template
```

4. Verify each creation response:

```json
{"status": true, "message": "template has been created successfully"}
```

5. Verify template rows:

```sql
SELECT template_id, template_name, template_status, template_category, approved_category, is_active
FROM commDB.meta_waba_templates
WHERE waba_id = '<waba_id>'
ORDER BY template_name;
```

Created templates usually start as `PENDING`; Meta webhook callbacks later move them to `APPROVED`.

6. Upsert comm config only after template IDs exist and the user provides the admin JWT.

## Program-Specific References

Load only the relevant reference:

- Point loyalty templates and config payload: `references/point-program.md`
- Marketing automation templates and config payload: `references/automation-program.md`
- Webhook replay and rejected-template troubleshooting: `references/webhook-replay.md`

For `visit`, ask the user for the event types, templates, and variable mappings. This skill currently contains concrete payloads for `point` and `automation` only.

## Fresh Creation Notes

For point templates, reuse the same payload shape/components as merchant `18794` approved UTILITY templates. Query source rows before creation:

```sql
SELECT template_name, template_category, approved_category, language, components, sample_text
FROM commDB.meta_waba_templates
WHERE waba_id IN (
  SELECT waba_id FROM commDB.meta_waba_info WHERE merchant_id = 18794
)
  AND template_status = 'APPROVED'
  AND approved_category = 'UTILITY'
ORDER BY template_name;
```

For automation templates, use `UTILITY`, no header, no footer, and no buttons. The exact body texts and variable arrays are in `references/automation-program.md`.

## Config Upsert APIs

Point loyalty config:

```text
PUT {env_api}/api/loyalty/admin/programs/comm-config
Authorization: Bearer <admin_token>
```

Expected:

```json
{"message": "comm configs upserted", "status": true}
```

Automation config:

```text
POST {env_api}/api/marketing/admin/automation/template
Authorization: Bearer <admin_token>
```

Expected:

```json
{"status": true}
```

## Verification Queries

Point loyalty:

```sql
SELECT pcc.merchant_id, pcc.program_type, pcc.event_type, pcc.medium,
       pcc.template_id, pcc.status, mwt.template_name, mwt.template_status
FROM loyaltyDB.program_comm_config pcc
JOIN commDB.meta_waba_templates mwt ON pcc.template_id = mwt.template_id
WHERE pcc.merchant_id = <merchant_id>
ORDER BY pcc.event_type;
```

Automation:

```sql
SELECT acc.merchant_id, acc.event_type, acc.variant, acc.medium,
       acc.event_id, acc.template_id, acc.status,
       mwt.template_name, mwt.template_status
FROM marketingDB.automation_comm_configs acc
JOIN commDB.meta_waba_templates mwt ON acc.template_id = mwt.template_id
WHERE acc.merchant_id = <merchant_id>
ORDER BY acc.event_type, acc.variant;
```

Events lookup:

```sql
SELECT id, event
FROM commDB.events
WHERE event IN (<template_names>);
```

## Gotchas

- If a template is `REJECTED` with reason `INVALID_FORMAT`, check `components` for bad placeholders. Use numbered variables like `{{2}}`, not literal `{brand_name}`.
- Remaining automation templates beyond the seven known event mappings need user-provided `event_type` and `variable_mapping` before linking.
- `coupon_expiry` currently maps to variant `no_deal` while using template `coupon_expiry_with_deal`.
- Meta webhooks land on prod. For staging templates stuck in `PENDING`, use `references/webhook-replay.md`.
