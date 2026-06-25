# Automation WABA Templates

Use this reference when program type is `automation`.

All automation templates use:

- Category: `UTILITY`
- Header: none
- Footer: none
- Buttons: none

Deal variant pattern:

- `{{1}} = first_name`
- `{{2}} = brand_name`
- `{{POS_DEAL}} = coupon_code` literal variable
- `{{4}} = validity`

No-deal variant pattern:

- `{{1}} = first_name`
- `{{2}} = brand_name`

Exception: `new_customer` config mapping is swapped: `1 = brand_name`, `2 = first_name`.

## Deal Variants

| template_name | Body text | Variables |
| --- | --- | --- |
| `new_trans_1st_trans_with_deal` | `Welcome to {{1}}!\n\nThanks for your first order, {{2}}. Use code {{POS_DEAL}} on your next visit.\n\nValid for {{4}} days.` | `["1","2","POS_DEAL","4"]` |
| `order_milestone_with_deal` | `Hey {{1}}, that's your {{2}} order with us!\n\nYou have been amazing. To celebrate, here is a deal, just for you. Code: {{POS_DEAL}}. Expires in {{4}} days.\n\nSee you!` | `["1","2","POS_DEAL","4"]` |
| `high_value_order_with_deal` | `Thank you, {{1}}!\n\nYour order at {{2}} qualifies for a unique deal. Use code {{POS_DEAL}} on your next visit. Valid for {{4}} days.` | `["1","2","POS_DEAL","4"]` |
| `coupon_expiry_with_deal` | `Hurry, {{1}}!\nYour coupon at {{2}} expires in {{3}} days. Use code {{4}} before it is gone.` | `["1","2","3","4"]` |
| `birthday_with_deal` | `Happy Birthday, {{1}}!\n{{2}} has a special gift for you. Use code {{POS_DEAL}}. Valid for {{4}} days. Hope your day is amazing!` | `["1","2","POS_DEAL","4"]` |
| `win_back_with_loyalty` | `Hey {{1}}\n\nWe miss you at {{2}}! It has been a while. We have added {{3}} bonus {{4}} to your account. Visit us to redeem them!` | `["1","2","3","4"]` |
| `win_back_with_loyalty1` | Same as `win_back_with_loyalty` | `["1","2","3","4"]` |
| `win_back_without_loyalty_with_deal` | `Hey {{1}}\n\nWe miss you at {{2}}! It's been a while. Here's a deal, just for you. Use code {{POS_DEAL}}. Valid for {{4}} days.` | `["1","2","POS_DEAL","4"]` |
| `at_risk_with_deal` | Same as `win_back_without_loyalty_with_deal` | `["1","2","POS_DEAL","4"]` |
| `new_cust_no_return_with_deal` | `Hey {{1}}\n\nIt's been a while since your first visit to {{2}}. We'd love to see you again! Use code {{POS_DEAL}} on your next order. Valid for {{4}} days.\nSee you soon!` | `["1","2","POS_DEAL","4"]` |

## No-Deal Variants

| template_name | Body text | Variables |
| --- | --- | --- |
| `new_trans_first_trans_without_deal` | `Welcome to {{1}}!\nThanks for your first order, {{2}}. We are so glad you chose us. See you again soon!` | `["1","2"]` |
| `order_milestone_without_deal` | `Hey {{1}}, that's your {{2}} order with us!\n\nYou have been amazing - we are so grateful for your love.\n\nSee you!` | `["1","2"]` |
| `high_value_order_without_deal` | `Thank you, {{1}}!\nYour order at {{2}} made our day. See you again soon!` | `["1","2"]` |
| `birthday_withou_deal` | `Happy Birthday, {{1}}!\nWishing you a fantastic day from all of us at {{2}}. Hope to celebrate with you soon!` | `["1","2"]` |
| `win_back_without_loyalty_without_deal` | `Hey {{1}}\nWe miss you at {{2}}! It has been a while. Come back and see what is new. We would love to have you back!` | `["1","2"]` |
| `at_risk_without_deal` | Same as `win_back_without_loyalty_without_deal` | `["1","2"]` |
| `new_cust_no_return_without_deal` | `Hey {{1}}\n\nIt has been a while since your first visit to {{2}}. We would love to see you again!\n\nSee you soon!` | `["1","2"]` |
| `feedack_positive` | `Thanks for the love, {{1}}!\nGlad you enjoyed {{2}}. Mind sharing your experience on Google? It won't take long: {{3}}.\n-TY` | `["1","2","3"]` |
| `feedback_negative` | `Hi {{1}}\nSorry your experience at {{2}} did not meet expectations. Help us improve - what went wrong? {{3}}.\n-TY` | `["1","2","3"]` |
| `post_trans_feedback_with_deal` | `Hey {{1}}\n\nHow was your experience at {{2}}? Rate us: {{3}}. Your feedback means a lot to us!` | `["1","2","3"]` |

## Known Event Type And Variant Mappings

From merchant `20217` automation configs:

| event_type | variant | template | eventId | variableMapping |
| --- | --- | --- | --- | --- |
| `new_customer` | `deal` | `new_trans_1st_trans_with_deal` | `70844` | `{"1":"brand_name","2":"first_name","POS_DEAL":"coupon_code","4":"validity"}` |
| `new_customer` | `no_deal` | `new_trans_first_trans_without_deal` | `70845` | `{"1":"brand_name","2":"first_name"}` |
| `order_milestone` | `deal` | `order_milestone_with_deal` | `70848` | `{"1":"first_name","2":"nth","POS_DEAL":"coupon_code","4":"N"}` |
| `order_milestone` | `no_deal` | `order_milestone_without_deal` | `70849` | `{"1":"first_name","2":"nth"}` |
| `high_value_order` | `deal` | `high_value_order_with_deal` | `70850` | `{"1":"first_name","2":"brand_name","POS_DEAL":"coupon_code","4":"validity"}` |
| `high_value_order` | `no_deal` | `high_value_order_without_deal` | `70851` | `{"1":"first_name","2":"brand_name"}` |
| `coupon_expiry` | `no_deal` | `coupon_expiry_with_deal` | `70852` | `{"1":"first_name","2":"brand_name","3":"X","4":"coupon_code"}` |

The remaining 13 templates do not have a defined `automation_comm_configs` entry in this playbook. Ask the user for `event_type` and `variable_mapping` before linking them.

## Upsert Payload

Endpoint:

```text
POST {env_api}/api/marketing/admin/automation/template
Authorization: Bearer <admin_token>
```

Payload:

```json
{
  "merchantId": <merchant_id>,
  "configs": [
    {
      "eventType": "new_customer",
      "medium": "wa",
      "eventId": 70844,
      "templateId": "<new_trans_1st_trans_with_deal_template_id>",
      "status": "active",
      "variableMapping": {"1": "brand_name", "2": "first_name", "POS_DEAL": "coupon_code", "4": "validity"},
      "variant": "deal"
    },
    {
      "eventType": "new_customer",
      "medium": "wa",
      "eventId": 70845,
      "templateId": "<new_trans_first_trans_without_deal_template_id>",
      "status": "active",
      "variableMapping": {"1": "brand_name", "2": "first_name"},
      "variant": "no_deal"
    },
    {
      "eventType": "order_milestone",
      "medium": "wa",
      "eventId": 70848,
      "templateId": "<order_milestone_with_deal_template_id>",
      "status": "active",
      "variableMapping": {"1": "first_name", "2": "nth", "POS_DEAL": "coupon_code", "4": "N"},
      "variant": "deal"
    },
    {
      "eventType": "order_milestone",
      "medium": "wa",
      "eventId": 70849,
      "templateId": "<order_milestone_without_deal_template_id>",
      "status": "active",
      "variableMapping": {"1": "first_name", "2": "nth"},
      "variant": "no_deal"
    },
    {
      "eventType": "high_value_order",
      "medium": "wa",
      "eventId": 70850,
      "templateId": "<high_value_order_with_deal_template_id>",
      "status": "active",
      "variableMapping": {"1": "first_name", "2": "brand_name", "POS_DEAL": "coupon_code", "4": "validity"},
      "variant": "deal"
    },
    {
      "eventType": "high_value_order",
      "medium": "wa",
      "eventId": 70851,
      "templateId": "<high_value_order_without_deal_template_id>",
      "status": "active",
      "variableMapping": {"1": "first_name", "2": "brand_name"},
      "variant": "no_deal"
    },
    {
      "eventType": "coupon_expiry",
      "medium": "wa",
      "eventId": 70852,
      "templateId": "<coupon_expiry_with_deal_template_id>",
      "status": "active",
      "variableMapping": {"1": "first_name", "2": "brand_name", "3": "X", "4": "coupon_code"},
      "variant": "no_deal"
    }
  ]
}
```

Expected response:

```json
{"status": true}
```
