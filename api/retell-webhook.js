/**
 * Retell AI → HubSpot Webhook Handler
 * 
 * Receives Retell's `call_analyzed` webhook events and:
 * 1. Extracts the 33 post-call analysis fields
 * 2. Creates/updates a HubSpot contact with mapped properties
 * 3. Creates a deal in the b/digital Engagements pipeline
 * 4. Logs the call summary as a note on the contact
 * 
 * Environment Variables Required:
 *   RETELL_API_KEY   – Retell API key (for signature verification)
 *   HUBSPOT_API_KEY  – HubSpot private app access token
 * 
 * Deploy: Vercel serverless function at /api/retell-webhook
 */

// ─── HubSpot Pipeline & Stage Constants ─────────────────────────────────────
const HUBSPOT_PIPELINE_ID = '2120352451'; // b/digital Engagements
const DEAL_STAGES = {
  'ai_intake':    '3354837724',
  'discovery':    '3354837725',
  'deep_dive':    '3354837726',
  'proposal':     '3354837727',
  'negotiation':  '3354837728',
  'closed_won':   '3354837729',
  'closed_lost':  '3354837730',
  'nurture':      '3401738960',
};

// Map Retell readiness_level to deal stage
const READINESS_TO_STAGE = {
  'not_ready':        DEAL_STAGES.nurture,
  'exploring':        DEAL_STAGES.ai_intake,
  'early_interest':   DEAL_STAGES.ai_intake,
  'evaluating':       DEAL_STAGES.discovery,
  'comparing':        DEAL_STAGES.discovery,
  'ready_to_start':   DEAL_STAGES.deep_dive,
  'ready_to_buy':     DEAL_STAGES.proposal,
  'urgent':           DEAL_STAGES.proposal,
};

// ─── Retell Post-Call Analysis Fields ────────────────────────────────────────
// These are the 33 fields extracted from Retell's call_analyzed event.
// They map to the `call_analysis` object in the webhook payload.
const RETELL_ANALYSIS_FIELDS = [
  // Caller Identity
  'caller_name',
  'caller_email',
  'caller_phone',
  'caller_company',
  'caller_role',
  // Property & Project Details
  'property_type',
  'property_address',
  'property_city',
  'property_state',
  'property_zip',
  'property_sqft',
  'number_of_rooms',
  'project_type',
  // Scope & Budget
  'illumination_tier',
  'predicted_project_scope',
  'budget_range',
  'budget_confirmed',
  'timeline',
  // Needs & Preferences
  'primary_needs',
  'secondary_needs',
  'preferred_brands',
  'existing_systems',
  'integration_requirements',
  // Qualification
  'readiness_level',
  'decision_maker',
  'decision_timeline',
  'competitive_situation',
  // Call Metadata
  'call_summary',
  'call_sentiment',
  'call_duration_seconds',
  'follow_up_required',
  'follow_up_notes',
  'agent_notes',
];

// ─── HubSpot API Helpers ─────────────────────────────────────────────────────

const HUBSPOT_BASE = 'https://api.hubapi.com';

async function hubspotRequest(method, path, body = null) {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token) throw new Error('HUBSPOT_API_KEY environment variable is not set');

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${HUBSPOT_BASE}${path}`, opts);
  const data = await res.json();

  if (!res.ok) {
    console.error(`HubSpot API error [${res.status}]:`, JSON.stringify(data));
    throw new Error(`HubSpot ${method} ${path} failed: ${res.status} – ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

// ─── Search for existing contact by email ────────────────────────────────────

async function findContactByEmail(email) {
  if (!email) return null;
  try {
    const data = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: 'EQ',
          value: email,
        }],
      }],
      properties: ['email', 'firstname', 'lastname', 'phone'],
      limit: 1,
    });
    return data.results && data.results.length > 0 ? data.results[0] : null;
  } catch (err) {
    console.warn('Contact search failed:', err.message);
    return null;
  }
}

// ─── Create or Update HubSpot Contact ────────────────────────────────────────

async function createOrUpdateContact(analysis) {
  const nameParts = (analysis.caller_name || '').trim().split(/\s+/);
  const firstname = nameParts[0] || '';
  const lastname = nameParts.slice(1).join(' ') || '';

  const properties = {
    firstname,
    lastname,
    email: analysis.caller_email || '',
    phone: analysis.caller_phone || '',
    company: analysis.caller_company || '',
    jobtitle: analysis.caller_role || '',
    address: analysis.property_address || '',
    city: analysis.property_city || '',
    state: analysis.property_state || '',
    zip: analysis.property_zip || '',
    // Custom properties (will be created in HubSpot if they don't exist)
    retell_project_type: analysis.project_type || '',
    retell_illumination_tier: analysis.illumination_tier || '',
    retell_property_type: analysis.property_type || '',
    retell_readiness_level: analysis.readiness_level || '',
    retell_budget_range: analysis.budget_range || '',
    retell_timeline: analysis.timeline || '',
    retell_primary_needs: analysis.primary_needs || '',
    retell_existing_systems: analysis.existing_systems || '',
    retell_call_sentiment: analysis.call_sentiment || '',
  };

  // Remove empty values to avoid overwriting existing data
  Object.keys(properties).forEach(key => {
    if (!properties[key]) delete properties[key];
  });

  // Try to find existing contact
  const existing = await findContactByEmail(analysis.caller_email);

  if (existing) {
    // Update existing contact
    const updated = await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${existing.id}`, { properties });
    console.log(`Updated existing contact ${existing.id}`);
    return updated;
  } else {
    // Create new contact
    const contact = await hubspotRequest('POST', '/crm/v3/objects/contacts', { properties });
    console.log(`Created new contact ${contact.id}`);
    return contact;
  }
}

// ─── Create HubSpot Deal ─────────────────────────────────────────────────────

function estimateDealAmount(scope) {
  const scopeMap = {
    'single_room':    5000,
    'multi_room':     15000,
    'whole_home':     50000,
    'estate':         150000,
    'commercial':     250000,
    'small':          5000,
    'medium':         25000,
    'large':          75000,
    'enterprise':     200000,
  };
  if (!scope) return 25000; // default
  const normalized = scope.toLowerCase().replace(/[\s-]/g, '_');
  return scopeMap[normalized] || 25000;
}

async function createDeal(analysis, contactId) {
  const callerName = analysis.caller_name || 'Unknown Caller';
  const projectType = analysis.project_type || 'AOP Project';
  const tier = analysis.illumination_tier || '';
  const readiness = (analysis.readiness_level || '').toLowerCase().replace(/[\s-]/g, '_');

  const dealstage = READINESS_TO_STAGE[readiness] || DEAL_STAGES.ai_intake;
  const amount = estimateDealAmount(analysis.predicted_project_scope);

  const dealName = `${callerName} – ${projectType}${tier ? ` (${tier})` : ''}`;

  const properties = {
    dealname: dealName,
    pipeline: HUBSPOT_PIPELINE_ID,
    dealstage,
    amount: String(amount),
    description: buildDealDescription(analysis),
    bd_service_type: 'AOP Technology Planning',
    hs_next_step: analysis.follow_up_notes || 'Schedule follow-up consultation',
  };

  const deal = await hubspotRequest('POST', '/crm/v3/objects/deals', { properties });
  console.log(`Created deal ${deal.id}: ${dealName}`);

  // Associate deal with contact
  if (contactId) {
    try {
      await hubspotRequest(
        'PUT',
        `/crm/v4/objects/deals/${deal.id}/associations/contacts/${contactId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] // deal-to-contact
      );
      console.log(`Associated deal ${deal.id} with contact ${contactId}`);
    } catch (err) {
      console.error('Deal-contact association failed:', err.message);
    }
  }

  return deal;
}

function buildDealDescription(analysis) {
  const lines = [];
  if (analysis.call_summary) lines.push(`CALL SUMMARY:\n${analysis.call_summary}`);
  if (analysis.property_type) lines.push(`Property Type: ${analysis.property_type}`);
  if (analysis.property_sqft) lines.push(`Square Footage: ${analysis.property_sqft}`);
  if (analysis.number_of_rooms) lines.push(`Number of Rooms: ${analysis.number_of_rooms}`);
  if (analysis.illumination_tier) lines.push(`Illumination Tier: ${analysis.illumination_tier}`);
  if (analysis.predicted_project_scope) lines.push(`Predicted Scope: ${analysis.predicted_project_scope}`);
  if (analysis.budget_range) lines.push(`Budget Range: ${analysis.budget_range}`);
  if (analysis.budget_confirmed) lines.push(`Budget Confirmed: ${analysis.budget_confirmed}`);
  if (analysis.timeline) lines.push(`Timeline: ${analysis.timeline}`);
  if (analysis.primary_needs) lines.push(`Primary Needs: ${analysis.primary_needs}`);
  if (analysis.secondary_needs) lines.push(`Secondary Needs: ${analysis.secondary_needs}`);
  if (analysis.preferred_brands) lines.push(`Preferred Brands: ${analysis.preferred_brands}`);
  if (analysis.existing_systems) lines.push(`Existing Systems: ${analysis.existing_systems}`);
  if (analysis.integration_requirements) lines.push(`Integration Reqs: ${analysis.integration_requirements}`);
  if (analysis.decision_maker) lines.push(`Decision Maker: ${analysis.decision_maker}`);
  if (analysis.decision_timeline) lines.push(`Decision Timeline: ${analysis.decision_timeline}`);
  if (analysis.competitive_situation) lines.push(`Competitive Situation: ${analysis.competitive_situation}`);
  if (analysis.agent_notes) lines.push(`\nAGENT NOTES:\n${analysis.agent_notes}`);
  return lines.join('\n');
}

// ─── Log Call as Note on Contact ─────────────────────────────────────────────

async function logCallNote(analysis, contactId) {
  if (!contactId) return null;

  const noteBody = [
    `📞 Retell AI Call – ${new Date().toISOString().split('T')[0]}`,
    `Duration: ${analysis.call_duration_seconds ? Math.round(analysis.call_duration_seconds / 60) + ' min' : 'N/A'}`,
    `Sentiment: ${analysis.call_sentiment || 'N/A'}`,
    `Readiness: ${analysis.readiness_level || 'N/A'}`,
    '',
    analysis.call_summary || 'No summary available.',
    '',
    analysis.follow_up_required ? `⚡ FOLLOW-UP REQUIRED: ${analysis.follow_up_notes || 'Yes'}` : '',
  ].filter(Boolean).join('\n');

  const note = await hubspotRequest('POST', '/crm/v3/objects/notes', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: noteBody,
    },
  });

  // Associate note with contact
  try {
    await hubspotRequest(
      'PUT',
      `/crm/v4/objects/notes/${note.id}/associations/contacts/${contactId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] // note-to-contact
    );
    console.log(`Logged note ${note.id} on contact ${contactId}`);
  } catch (err) {
    console.error('Note-contact association failed:', err.message);
  }

  return note;
}

// ─── Signature Verification (Optional) ──────────────────────────────────────

function verifyRetellSignature(req, body) {
  // Retell uses a simple API key check via x-retell-signature header
  // In production, implement HMAC verification if Retell provides a signing secret
  const signature = req.headers['x-retell-signature'];
  const apiKey = process.env.RETELL_API_KEY;
  
  if (!apiKey) {
    console.warn('RETELL_API_KEY not set – skipping signature verification');
    return true;
  }
  
  // Basic key matching (Retell sends the API key as the signature)
  if (signature && signature !== apiKey) {
    console.warn('Invalid Retell signature');
    return false;
  }
  
  return true;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS headers for preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-retell-signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = req.body;

    // Verify signature
    if (!verifyRetellSignature(req, body)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Retell sends different event types — we only care about call_analyzed
    const eventType = body.event;
    if (eventType !== 'call_analyzed') {
      console.log(`Ignoring event type: ${eventType}`);
      return res.status(200).json({ 
        status: 'ignored', 
        message: `Event type '${eventType}' not processed. Only 'call_analyzed' is handled.` 
      });
    }

    // Extract analysis data
    // Retell nests analysis under body.data.call_analysis or body.call_analysis
    const callData = body.data || body;
    const analysis = callData.call_analysis || callData.analysis || {};
    const callId = callData.call_id || body.call_id || 'unknown';

    console.log(`Processing call_analyzed for call ${callId}`);
    console.log(`Analysis fields present: ${Object.keys(analysis).length}`);

    // Validate minimum required data
    if (!analysis.caller_name && !analysis.caller_email && !analysis.caller_phone) {
      console.warn('No caller identity fields found in analysis');
      return res.status(200).json({
        status: 'skipped',
        message: 'No caller identity data (name, email, or phone) found in call analysis.',
        call_id: callId,
      });
    }

    // Step 1: Create/update HubSpot contact
    const contact = await createOrUpdateContact(analysis);
    const contactId = contact.id;

    // Step 2: Create deal in pipeline
    const deal = await createDeal(analysis, contactId);

    // Step 3: Log call as note on contact
    const note = await logCallNote(analysis, contactId);

    // Build response
    const response = {
      status: 'success',
      call_id: callId,
      hubspot: {
        contact_id: contactId,
        contact_email: analysis.caller_email || null,
        deal_id: deal.id,
        deal_name: deal.properties?.dealname || null,
        note_id: note?.id || null,
      },
      fields_processed: Object.keys(analysis).length,
      timestamp: new Date().toISOString(),
    };

    console.log('Webhook processed successfully:', JSON.stringify(response));
    return res.status(200).json(response);

  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};
