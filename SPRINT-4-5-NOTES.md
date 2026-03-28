# Sprints 4 & 5 — D-Tools Integration + Client Portal

## What Was Built

### Sprint 4: D-Tools Integration

#### 4A — `/api/dtools-catalog.js`
- Proxies D-Tools Cloud API (`/Products/GetProducts?pageSize=500&pageNumber={n}`)
- Auth: `X-API-Key` header + `Authorization: Basic RFRDb...` (static)
- **Paginated fetch** — loops until fewer than 500 results returned (max 20 pages)
- **AOP category classification** — maps each product via brand/system/category to: Illumination, Immersion, Equilibrium, Autonomy, Perimeter, Continuity
- **1-hour in-memory cache** — avoids hitting D-Tools on every request
- **Query modes:**
  - `?summary=true` — returns ROM ranges per AOP category (used by Investment Window)
  - `?category=illumination` — returns products for one category
  - `?category=illumination&tier=full_spectrum` — tier-filtered
  - No params — full catalog dump
- **Graceful fallback** — returns ROM estimates if D-Tools key is missing or API fails

#### 4B — `/api/dtools-opportunity.js`
- POST endpoint that creates a D-Tools Opportunity from visualizer state
- **Client matching** — searches for existing client by email before creating new
- **Line items** — splits estimated amount across selected AOP categories by weighting
- **Notes field** — includes full room/system map and tier selection
- Returns `opportunityId` and `opportunityNumber`
- **Mock mode** — returns a mock opportunity if `DTOOLS_API_KEY` is unset

#### 4C — Investment Window (Phase 3)
- New **Phase 3 screen** (`id="phase3"`) — fully rendered by `renderPhase3()` async function
- **Loading spinner** while fetching D-Tools summary
- **Investment grid** — one card per selected AOP category, showing ROM range
- **Illumination tier adjustment** — multiplies range by tier factor (Curated: 0.45×, Living: 0.72×, Full Spectrum: 1.0×)
- **Live D-Tools badge** — "Live D-Tools Pricing" indicator on cards when real data is available
- **Total range banner** — sums all selected categories
- **"Powered by D-Tools" badge** — shown at bottom of total when live data present
- **Graceful fallback** — uses hardcoded ROM estimates if D-Tools is unavailable
- Phase 2 CTA now includes "View Investment Window →" as primary action

#### 4D — "Save to D-Tools" Button
- Appears in Phase 3 CTA **only when** `state.intake.name` AND `state.intake.email` are both populated (captured via voice concierge)
- Shows loading spinner while calling `/api/dtools-opportunity`
- On success: shows opportunity number confirmation, hides button
- On failure: shows error message, re-enables button

---

### Sprint 5: Client Portal

#### 5A — URL State Serialization
- `encodeStateToUrl(state, 'session' | 'view')` — serializes full state as base64-encoded JSON URL param
- `decodeStateFromParam(b64)` — decodes and validates
- `checkUrlParams()` — called in `init()`, handles both modes:
  - `?session=BASE64` — restores state and cleans URL
  - `?view=BASE64` — restores read-only state with banner

#### 5B — `/api/send-save-link.js`
- Accepts: `{ email, name, sessionUrl }`
- Finds or creates HubSpot contact
- Creates an engagement Note with the magic URL
- Attempts transactional email send (requires `HUBSPOT_SAVE_LINK_EMAIL_ID` env var for template)
- Updates contact with `aop_last_saved` and `aop_session_url` properties
- **Always shows success** to user (URL is client-generated and valid regardless)

#### 5C — "Share with Design Team" Modal
- "Share with Design Team" button in Phase 3 CTA
- Opens modal showing `?view=BASE64` URL (read-only mode)
- Copy-to-clipboard with "Copied!" feedback
- Read-only view: loads with floating banner "Viewing shared selections — shared by [Name]"
- All edit controls disabled (CSS `pointer-events: none` on rooms/systems/tiers)
- Voice FAB hidden when `body.readonly-mode` active

#### 5D — index.html Updates
- Phase 2 CTA: "View Investment Window →" (primary, gold), "Schedule a Conversation" (ghost), "Save Progress" (subtle), Print button (unchanged)
- Phase 3 CTA: "Schedule a Consultation", "Share with Design Team", "Save Progress", "Save to D-Tools" (if contact info present)
- `init()` now calls `checkUrlParams()` before rendering
- `navigateTo()` now handles `phase3` (renders `renderPhase3()`)
- Voice FAB now shows on Phase 3 screen
- Read-only banner at top of page in `?view=` mode

---

## Environment Variables Required

| Variable | Used By | Description |
|---|---|---|
| `DTOOLS_API_KEY` | dtools-catalog, dtools-opportunity | D-Tools Cloud API key |
| `HUBSPOT_API_KEY` | send-save-link | HubSpot private app token |
| `HUBSPOT_SAVE_LINK_EMAIL_ID` | send-save-link | Optional: HubSpot email template ID for transactional send |

D-Tools Basic Auth is hardcoded as a constant (as specified): `RFRDbG91ZEFQSVVzZXI6MyNRdVkrMkR1QCV3Kk15JTU8Yi1aZzlV`

## Files Modified/Created

- **CREATED** `/api/dtools-catalog.js` — 351 lines
- **CREATED** `/api/dtools-opportunity.js` — 293 lines  
- **CREATED** `/api/send-save-link.js` — 198 lines
- **MODIFIED** `/api/index.html` — grew from 6,680 → 7,925 lines (+1,245 lines)
- **MODIFIED** `/vercel.json` — added GET, PUT to allowed methods
