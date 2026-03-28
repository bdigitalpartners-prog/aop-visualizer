/**
 * Retell AI → HubSpot Webhook Handler (Sprint 1 — Intelligence Loop)
 * 
 * Receives Retell's `call_analyzed` webhook events and:
 * 1. Creates/updates a HubSpot contact with caller identity
 * 2. Logs the full call transcript + analysis as a rich note
 * 3. Creates a deal in the b/digital Engagements pipeline
 * 4. Creates a follow-up task assigned to Calvin
 * 
 * Environment Variables:
 *   HUBSPOT_API_KEY  – HubSpot private app access token
 *   RETELL_API_KEY   – Retell API key (for fetching transcript)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const HUBSPOT_BASE = 'https://api.hubapi.com';
const RETELL_BASE = 'https://api.retellai.com';

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

const CALVIN_OWNER_ID = '89511141';

const READINESS_TO_STAGE = {
  'ready_now':     DEAL_STAGES.deep_dive,
  '3_6_months':    DEAL_STAGES.discovery,
  '6_12_months':   DEAL_STAGES.ai_intake,
  'exploring':     DEAL_STAGES.ai_intake,
  'unclear':       DEAL_STAGES.ai_intake,
};

const SCOPE_TO_AMOUNT = {
  'under_200k':  125000,
  '200k_500k':   350000,
  '500k_1m':     750000,
  'over_1m':     1250000,
  'unclear':     200000,
};

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function hubspot(method, path, body = null) {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token || token === 'placeholder') throw new Error('HUBSPOT_API_KEY not configured');
  
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  
  const res = await fetch(`${HUBSPOT_BASE}${path}`, opts);
  
  // Handle 204 No Content (e.g., from associations)
  if (res.status === 204) return {};
  
  const data = await res.json();
  if (!res.ok) {
    console.error(`HubSpot ${method} ${path} [${res.status}]:`, JSON.stringify(data));
    throw new Error(`HubSpot ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

async function retellGet(path) {
  const key = process.env.RETELL_API_KEY;
  if (!key) return null;
  
  try {
    const res = await fetch(`${RETELL_BASE}${path}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('Retell API error:', err.message);
    return null;
  }
}

// ─── Contact Management ──────────────────────────────────────────────────────

async function findContactByEmail(email) {
  if (!email) return null;
  try {
    const data = await hubspot('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email', 'firstname', 'lastname', 'phone'],
      limit: 1,
    });
    return data.results?.[0] || null;
  } catch { return null; }
}

async function findContactByPhone(phone) {
  if (!phone) return null;
  try {
    const data = await hubspot('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
      properties: ['email', 'firstname', 'lastname', 'phone'],
      limit: 1,
    });
    return data.results?.[0] || null;
  } catch { return null; }
}

async function createOrUpdateContact(analysis) {
  const nameParts = (analysis.caller_name || '').trim().split(/\s+/);
  const firstname = nameParts[0] || '';
  const lastname = nameParts.slice(1).join(' ') || '';

  const properties = {};
  
  // Only set non-empty values
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;
  if (analysis.caller_email) properties.email = analysis.caller_email;
  if (analysis.caller_phone) properties.phone = analysis.caller_phone;
  if (analysis.location) properties.city = analysis.location;
  
  // Set lifecycle and lead source
  properties.lifecyclestage = 'lead';
  properties.hs_lead_status = 'NEW';

  // Try to find existing contact
  const existing = await findContactByEmail(analysis.caller_email) 
                || await findContactByPhone(analysis.caller_phone);

  if (existing) {
    const updated = await hubspot('PATCH', `/crm/v3/objects/contacts/${existing.id}`, { properties });
    console.log(`Updated contact ${existing.id}`);
    return updated;
  } else {
    const contact = await hubspot('POST', '/crm/v3/objects/contacts', { properties });
    console.log(`Created contact ${contact.id}`);
    return contact;
  }
}

// ─── Deal Management ─────────────────────────────────────────────────────────

async function createDeal(analysis, contactId) {
  const callerName = analysis.caller_name || 'Voice Concierge Lead';
  const projectType = analysis.project_type || 'Consultation';
  const scope = (analysis.predicted_project_scope || 'unclear').toLowerCase();
  const readiness = (analysis.readiness_level || 'unclear').toLowerCase();
  
  const dealstage = READINESS_TO_STAGE[readiness] || DEAL_STAGES.ai_intake;
  const amount = SCOPE_TO_AMOUNT[scope] || 200000;
  
  // Build deal name
  const tierStr = analysis.illumination_tier && analysis.illumination_tier !== 'not_discussed' 
    ? ` (${analysis.illumination_tier.replace(/_/g, ' ')})` : '';
  const dealName = `${callerName} – ${projectType.replace(/_/g, ' ')}${tierStr}`;

  const properties = {
    dealname: dealName,
    pipeline: HUBSPOT_PIPELINE_ID,
    dealstage,
    amount: String(amount),
    description: buildDealDescription(analysis),
    hubspot_owner_id: CALVIN_OWNER_ID,
    hs_next_step: 'Schedule follow-up consultation',
  };

  const deal = await hubspot('POST', '/crm/v3/objects/deals', { properties });
  console.log(`Created deal ${deal.id}: ${dealName}`);

  // Associate deal with contact
  if (contactId) {
    try {
      await hubspot('PUT', `/crm/v4/objects/deals/${deal.id}/associations/contacts/${contactId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]);
    } catch (err) { console.error('Deal association failed:', err.message); }
  }

  return deal;
}

function buildDealDescription(a) {
  const lines = [];
  
  // Project
  if (a.project_type) lines.push(`Project: ${a.project_type.replace(/_/g, ' ')}`);
  if (a.project_stage) lines.push(`Stage: ${a.project_stage.replace(/_/g, ' ')}`);
  if (a.location) lines.push(`Location: ${a.location}`);
  if (a.estimated_room_count) lines.push(`Rooms: ${a.estimated_room_count}`);
  if (a.architect_builder) lines.push(`Architect/Builder: ${a.architect_builder}`);
  if (a.timeline) lines.push(`Timeline: ${a.timeline}`);
  
  // Scope
  if (a.predicted_project_scope) lines.push(`Predicted Scope: ${a.predicted_project_scope.replace(/_/g, ' ')}`);
  if (a.readiness_level) lines.push(`Readiness: ${a.readiness_level.replace(/_/g, ' ')}`);
  
  // Experience interests
  const interests = [];
  if (a.illumination_tier && a.illumination_tier !== 'not_discussed') interests.push(`Illumination: ${a.illumination_tier.replace(/_/g, ' ')}`);
  if (a.cinema_interested === 'yes') interests.push('Cinema: yes');
  if (a.listening_room_interested === 'yes') interests.push('Listening Room: yes');
  if (a.distributed_audio === 'yes') interests.push('Distributed Audio: yes');
  if (a.perimeter_interested === 'yes') interests.push(`Perimeter: ${a.perimeter_depth || 'yes'}`);
  if (a.continuity_interested === 'yes') interests.push(`Continuity: ${a.continuity_level || 'yes'}`);
  if (a.comfort_zones && a.comfort_zones !== 'not_discussed') interests.push(`Comfort Zones: ${a.comfort_zones}`);
  if (interests.length) lines.push(`\nExperience Interests: ${interests.join(', ')}`);
  
  // Lifestyle
  const lifestyle = [];
  if (a.music_lover === 'very_important') lifestyle.push('Music lover');
  if (a.film_lover === 'very_important') lifestyle.push('Film lover');
  if (a.entertains_often === 'yes') lifestyle.push('Entertains often');
  if (a.outdoor_living_important === 'very_important') lifestyle.push('Outdoor living priority');
  if (a.works_from_home === 'yes') lifestyle.push('Works from home');
  if (lifestyle.length) lines.push(`Lifestyle: ${lifestyle.join(', ')}`);
  
  if (a.dream_feature) lines.push(`Dream Feature: ${a.dream_feature}`);
  if (a.biggest_frustration) lines.push(`Biggest Frustration: ${a.biggest_frustration}`);
  if (a.previous_tech_experience) lines.push(`Previous Tech: ${a.previous_tech_experience}`);
  
  return lines.join('\n');
}

// ─── Call Note with Transcript ───────────────────────────────────────────────

async function logCallNote(analysis, transcript, callId, contactId, dealId) {
  if (!contactId) return null;

  const date = new Date().toISOString().split('T')[0];
  const duration = analysis.call_duration_seconds 
    ? `${Math.round(analysis.call_duration_seconds / 60)} min` : 'N/A';
  
  // Build rich note
  const sections = [];
  
  sections.push(`<h3>🎙 AOP Voice Concierge Call — ${date}</h3>`);
  sections.push(`<p><strong>Duration:</strong> ${duration} | <strong>Readiness:</strong> ${analysis.readiness_level || 'N/A'} | <strong>Scope:</strong> ${analysis.predicted_project_scope?.replace(/_/g, ' ') || 'N/A'}</p>`);
  
  // Call Summary
  if (analysis.call_summary) {
    sections.push(`<h4>Summary</h4><p>${analysis.call_summary}</p>`);
  }
  
  // Experience Interests snapshot
  const cats = [];
  if (analysis.illumination_tier && analysis.illumination_tier !== 'not_discussed') 
    cats.push(`Illumination: ${analysis.illumination_tier.replace(/_/g, ' ')}`);
  if (analysis.cinema_interested && analysis.cinema_interested !== 'not_discussed') 
    cats.push(`Cinema: ${analysis.cinema_interested}`);
  if (analysis.listening_room_interested && analysis.listening_room_interested !== 'not_discussed') 
    cats.push(`Listening Room: ${analysis.listening_room_interested}`);
  if (analysis.distributed_audio && analysis.distributed_audio !== 'not_discussed') 
    cats.push(`Distributed Audio: ${analysis.distributed_audio}`);
  if (analysis.comfort_zones && analysis.comfort_zones !== 'not_discussed') 
    cats.push(`Equilibrium: ${analysis.comfort_zones.replace(/_/g, ' ')}`);
  if (analysis.perimeter_interested && analysis.perimeter_interested !== 'not_discussed') 
    cats.push(`Perimeter: ${analysis.perimeter_interested}`);
  if (analysis.continuity_interested && analysis.continuity_interested !== 'not_discussed') 
    cats.push(`Continuity: ${analysis.continuity_interested}`);
  
  if (cats.length) {
    sections.push(`<h4>Experience Interests</h4><p>${cats.join('<br>')}</p>`);
  }
  
  // Lifestyle signals
  const signals = [];
  if (analysis.music_lover && analysis.music_lover !== 'not_discussed') signals.push(`Music: ${analysis.music_lover}`);
  if (analysis.film_lover && analysis.film_lover !== 'not_discussed') signals.push(`Film: ${analysis.film_lover}`);
  if (analysis.entertains_often && analysis.entertains_often !== 'not_discussed') signals.push(`Entertains: ${analysis.entertains_often}`);
  if (analysis.outdoor_living_important && analysis.outdoor_living_important !== 'not_discussed') signals.push(`Outdoor Living: ${analysis.outdoor_living_important}`);
  if (analysis.works_from_home && analysis.works_from_home !== 'not_discussed') signals.push(`WFH: ${analysis.works_from_home}`);
  if (analysis.sleep_quality_priority && analysis.sleep_quality_priority !== 'not_discussed') signals.push(`Sleep Quality: ${analysis.sleep_quality_priority}`);
  if (analysis.wellness_interest && analysis.wellness_interest !== 'not_discussed') signals.push(`Wellness: ${analysis.wellness_interest}`);
  
  if (signals.length) {
    sections.push(`<h4>Lifestyle Profile</h4><p>${signals.join('<br>')}</p>`);
  }
  
  // Dream feature / frustration
  if (analysis.dream_feature) sections.push(`<p><strong>Dream Feature:</strong> ${analysis.dream_feature}</p>`);
  if (analysis.biggest_frustration) sections.push(`<p><strong>Biggest Frustration:</strong> ${analysis.biggest_frustration}</p>`);
  
  // Full transcript
  if (transcript) {
    // Format transcript with speaker labels
    const formatted = transcript
      .replace(/Agent:/g, '<strong>Concierge:</strong>')
      .replace(/User:/g, '<strong>Client:</strong>')
      .replace(/\n/g, '<br>');
    sections.push(`<h4>Full Transcript</h4><p style="font-size:12px;color:#666;">${formatted}</p>`);
  }
  
  sections.push(`<p style="font-size:11px;color:#999;">Call ID: ${callId} | Processed: ${new Date().toISOString()}</p>`);

  const note = await hubspot('POST', '/crm/v3/objects/notes', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: sections.join('\n'),
    },
  });

  // Associate with contact
  try {
    await hubspot('PUT', `/crm/v4/objects/notes/${note.id}/associations/contacts/${contactId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]);
  } catch (err) { console.error('Note-contact association failed:', err.message); }

  // Associate with deal
  if (dealId) {
    try {
      await hubspot('PUT', `/crm/v4/objects/notes/${note.id}/associations/deals/${dealId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]);
    } catch (err) { console.error('Note-deal association failed:', err.message); }
  }

  console.log(`Logged note ${note.id} with transcript on contact ${contactId}`);
  return note;
}

// ─── Follow-up Task ──────────────────────────────────────────────────────────

async function createFollowUpTask(analysis, contactId, dealId) {
  if (!contactId) return null;

  const callerName = analysis.caller_name || 'Voice Concierge Lead';
  const readiness = analysis.readiness_level || 'unclear';
  
  // Set due date based on readiness
  const now = new Date();
  let dueDate;
  switch (readiness) {
    case 'ready_now':    dueDate = addDays(now, 1); break;  // Tomorrow
    case '3_6_months':   dueDate = addDays(now, 3); break;  // 3 days
    case '6_12_months':  dueDate = addDays(now, 7); break;  // 1 week
    default:             dueDate = addDays(now, 2); break;  // 2 days
  }

  // Build interests summary for task body
  const interests = [];
  if (analysis.illumination_tier && analysis.illumination_tier !== 'not_discussed') interests.push('Illumination');
  if (analysis.cinema_interested === 'yes') interests.push('Cinema');
  if (analysis.listening_room_interested === 'yes') interests.push('Listening Room');
  if (analysis.distributed_audio === 'yes') interests.push('Distributed Audio');
  if (analysis.perimeter_interested === 'yes') interests.push('Perimeter');
  if (analysis.continuity_interested === 'yes') interests.push('Continuity');
  if (analysis.comfort_zones && analysis.comfort_zones !== 'not_discussed') interests.push('Equilibrium');
  
  const interestStr = interests.length ? interests.join(', ') : 'general inquiry';
  const scopeStr = analysis.predicted_project_scope ? analysis.predicted_project_scope.replace(/_/g, ' ') : 'TBD';
  
  const taskBody = `Voice concierge call completed. ${callerName} expressed interest in: ${interestStr}. ` +
    `Predicted scope: ${scopeStr}. Readiness: ${readiness.replace(/_/g, ' ')}. ` +
    (analysis.dream_feature ? `Dream feature: ${analysis.dream_feature}. ` : '') +
    `Review the call transcript in the contact notes and schedule a personal follow-up.`;

  const task = await hubspot('POST', '/crm/v3/objects/tasks', {
    properties: {
      hs_task_subject: `Follow up: ${callerName} — ${interestStr}`,
      hs_task_body: taskBody,
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: readiness === 'ready_now' ? 'HIGH' : 'MEDIUM',
      hs_timestamp: dueDate.toISOString(),
      hs_task_type: 'CALL',
      hubspot_owner_id: CALVIN_OWNER_ID,
    },
  });

  // Associate with contact
  try {
    await hubspot('PUT', `/crm/v4/objects/tasks/${task.id}/associations/contacts/${contactId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }]);
  } catch (err) { console.error('Task-contact association failed:', err.message); }

  // Associate with deal
  if (dealId) {
    try {
      await hubspot('PUT', `/crm/v4/objects/tasks/${task.id}/associations/deals/${dealId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }]);
    } catch (err) { console.error('Task-deal association failed:', err.message); }
  }

  console.log(`Created task ${task.id}: Follow up with ${callerName} (due ${dueDate.toISOString().split('T')[0]})`);
  return task;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ─── Fetch Full Transcript from Retell ───────────────────────────────────────

async function fetchTranscript(callId) {
  if (!callId || callId === 'unknown') return null;
  
  const callData = await retellGet(`/v2/get-call/${callId}`);
  if (!callData) return null;
  
  // Return the string transcript
  return callData.transcript || null;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-retell-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    const eventType = body.event;
    
    if (eventType !== 'call_analyzed') {
      return res.status(200).json({ 
        status: 'ignored', 
        message: `Event type '${eventType}' not processed. Only 'call_analyzed' is handled.` 
      });
    }

    // Extract analysis — Retell nests under data.call_analysis or call_analysis
    const callData = body.data || body;
    const analysis = callData.call_analysis?.custom_analysis_data 
                  || callData.call_analysis 
                  || callData.analysis?.custom_analysis_data
                  || callData.analysis 
                  || {};
    const callId = callData.call_id || body.call_id || 'unknown';
    
    // Also grab the built-in call_summary if our custom one is missing
    if (!analysis.call_summary && callData.call_analysis?.call_summary) {
      analysis.call_summary = callData.call_analysis.call_summary;
    }

    console.log(`\n━━━ Processing call_analyzed: ${callId} ━━━`);
    console.log(`Analysis fields: ${Object.keys(analysis).length}`);
    console.log(`Caller: ${analysis.caller_name || 'unknown'} | Email: ${analysis.caller_email || 'none'} | Phone: ${analysis.caller_phone || 'none'}`);

    // Skip if no identity
    if (!analysis.caller_name && !analysis.caller_email && !analysis.caller_phone) {
      console.warn('No caller identity — skipping');
      return res.status(200).json({ status: 'skipped', message: 'No caller identity data found.', call_id: callId });
    }

    // Step 1: Fetch full transcript from Retell API
    console.log('Fetching transcript...');
    const transcript = await fetchTranscript(callId);
    console.log(`Transcript: ${transcript ? transcript.length + ' chars' : 'not available'}`);

    // Step 2: Create/update HubSpot contact
    console.log('Creating/updating contact...');
    const contact = await createOrUpdateContact(analysis);
    const contactId = contact.id;

    // Step 3: Create deal
    console.log('Creating deal...');
    const deal = await createDeal(analysis, contactId);

    // Step 4: Log call note with transcript
    console.log('Logging call note with transcript...');
    const note = await logCallNote(analysis, transcript, callId, contactId, deal.id);

    // Step 5: Create follow-up task
    console.log('Creating follow-up task...');
    const task = await createFollowUpTask(analysis, contactId, deal.id);

    const response = {
      status: 'success',
      call_id: callId,
      hubspot: {
        contact_id: contactId,
        deal_id: deal.id,
        note_id: note?.id || null,
        task_id: task?.id || null,
      },
      caller: analysis.caller_name || null,
      readiness: analysis.readiness_level || null,
      scope: analysis.predicted_project_scope || null,
      transcript_captured: !!transcript,
      fields_processed: Object.keys(analysis).length,
      timestamp: new Date().toISOString(),
    };

    console.log('━━━ Success:', JSON.stringify(response));
    return res.status(200).json(response);

  } catch (error) {
    console.error('━━━ Webhook error:', error);
    return res.status(500).json({ status: 'error', message: error.message, timestamp: new Date().toISOString() });
  }
};
