# Point Program WABA Templates

Use this reference when program type is `point`.

## Templates

Create 6 UTILITY templates. Prefer copying payload components from merchant `18794` approved rows, then changing only the target merchant/WABA-specific fields required by the create-template API.

| Event type | Source template name | Category | Variables |
| --- | --- | --- | --- |
| `point_based_enroll` | `enrolment_confirmation` | `UTILITY` | 9: customer_name, store_name, program_name, store_name, earn_rate, collectible_name, earn_threshold, collectible_name, max_discount |
| `point_based_opt_out` | `opt_out_confirmation` | `UTILITY` | 3: customer_name, store_name, program_name |
| `points_earned` | `points_earned` | `UTILITY` | 9: customer_name, points, collectible_name, store_name, total_points, collectible_name, balance_inr_value, collectible_name, expiry_days |
| `points_expiring` | `points_expiry` | `UTILITY` | 5: customer_name, total_points, collectible_name, store_name, balance_inr_value |
| `points_redeemed` | `points_redeemed` | `UTILITY` | 7: customer_name, points, collectible_name, store_name, redeemed_inr_value, total_points, collectible_name |
| `welcome_bonus` | `bonus_points` | `UTILITY` | 6: customer_name, points, collectible_name, program_name, collectible_name, expiry_date |

## Comm Config Upsert

Endpoint:

```text
PUT {env_api}/api/loyalty/admin/programs/comm-config
Authorization: Bearer <admin_token>
```

Payload:

```json
{
  "merchantId": <merchant_id>,
  "programType": "point",
  "configs": [
    {
      "eventType": "point_based_enroll",
      "medium": "wa",
      "templateId": "<enrolment_confirmation_template_id>",
      "status": "A",
      "variableMapping": {"1": "customer_name", "2": "store_name", "3": "program_name", "4": "store_name", "5": "earn_rate", "6": "collectible_name", "7": "earn_threshold", "8": "collectible_name", "9": "max_discount"}
    },
    {
      "eventType": "point_based_opt_out",
      "medium": "wa",
      "templateId": "<opt_out_confirmation_template_id>",
      "status": "A",
      "variableMapping": {"1": "customer_name", "2": "store_name", "3": "program_name"}
    },
    {
      "eventType": "points_earned",
      "medium": "wa",
      "templateId": "<points_earned_template_id>",
      "status": "A",
      "variableMapping": {"1": "customer_name", "2": "points", "3": "collectible_name", "4": "store_name", "5": "total_points", "6": "collectible_name", "7": "balance_inr_value", "8": "collectible_name", "9": "expiry_days"}
    },
    {
      "eventType": "points_expiring",
      "medium": "wa",
      "templateId": "<points_expiry_template_id>",
      "status": "A",
      "variableMapping": {"1": "customer_name", "2": "total_points", "3": "collectible_name", "4": "store_name", "5": "balance_inr_value"},
      "reminderDays": [3]
    },
    {
      "eventType": "points_redeemed",
      "medium": "wa",
      "templateId": "<points_redeemed_template_id>",
      "status": "A",
      "variableMapping": {"1": "customer_name", "2": "points", "3": "collectible_name", "4": "store_name", "5": "redeemed_inr_value", "6": "total_points", "7": "collectible_name"}
    },
    {
      "eventType": "welcome_bonus",
      "medium": "wa",
      "templateId": "<bonus_points_template_id>",
      "status": "A",
      "variableMapping": {"1": "customer_name", "2": "points", "3": "collectible_name", "4": "program_name", "5": "collectible_name", "6": "expiry_date"}
    }
  ]
}
```

Expected response:

```json
{"message": "comm configs upserted", "status": true}
```
