# AOP Visualizer — Deployment & Integration Notes

## Repository
- **GitHub**: `bdigitalpartners-prog/aop-visualizer` (main branch)
- **Files in repo**:
  - `index.html` — AOP Visualizer v3 (3,542 lines, single-file app)
  - `api/retell-webhook.js` — Retell → HubSpot webhook serverless function
  - `vercel.json` — Vercel deployment configuration
  - `package.json` — Project manifest

## Vercel Deployment Steps for Calvin

1. Go to [vercel.com](https://vercel.com) → New Project
2. Import the `bdigitalpartners-prog/aop-visualizer` GitHub repo
3. Framework Preset: **Other** (no framework)
4. Deploy — it will auto-detect the vercel.json config
5. Add custom domain: `visualizer.artofpossible.com`

### Environment Secrets (must be added in Vercel dashboard)

```bash
# In Vercel project → Settings → Environment Variables
vercel secrets add retell-api-key "your-retell-api-key-here"
vercel secrets add hubspot-api-key "your-hubspot-private-app-token-here"
```

Or add via Dashboard → Project → Settings → Environment Variables:
- `RETELL_API_KEY` = your Retell API key
- `HUBSPOT_API_KEY` = your HubSpot private app access token

### HubSpot Private App Setup

The webhook requires a **HubSpot Private App** with these scopes:
- `crm.objects.contacts.write`
- `crm.objects.contacts.read`
- `crm.objects.deals.write`
- `crm.objects.deals.read`
- `crm.objects.notes.write` (for call logging)

Create at: HubSpot → Settings → Integrations → Private Apps → Create a private app

### HubSpot Custom Properties Required

The webhook writes to these custom contact properties (create them in HubSpot):
- `retell_project_type` (Single-line text)
- `retell_illumination_tier` (Single-line text)
- `retell_property_type` (Single-line text)
- `retell_readiness_level` (Single-line text)
- `retell_budget_range` (Single-line text)
- `retell_timeline` (Single-line text)
- `retell_primary_needs` (Single-line text)
- `retell_existing_systems` (Single-line text)
- `retell_call_sentiment` (Single-line text)

### Retell Webhook Configuration

In Retell dashboard, set the webhook URL to:
```
https://visualizer.artofpossible.com/api/retell-webhook
```
Event type: `call_analyzed`

## Architecture

```
visualizer.artofpossible.com
├── / → index.html (AOP Visualizer SPA)
└── /api/retell-webhook → Serverless function
    ├── Receives Retell call_analyzed events (33 fields)
    ├── Creates/updates HubSpot contact
    ├── Creates deal in "b/digital Engagements" pipeline
    │   └── Stage mapped from readiness_level
    └── Logs call as note on contact
```

## HubSpot Pipeline Mapping

- **Pipeline**: b/digital Engagements (`2120352451`)
- **Stage mapping** (readiness_level → deal stage):
  - not_ready → Nurture
  - exploring / early_interest → AI Intake
  - evaluating / comparing → Discovery
  - ready_to_start → Deep Dive
  - ready_to_buy / urgent → Proposal

## Current HubSpot Connector Status

Note: The HubSpot connector currently has **read-only** access (write is NOT_AVAILABLE). 
The webhook server uses the HubSpot REST API directly via a private app token 
(`HUBSPOT_API_KEY` env var), which bypasses this limitation.
