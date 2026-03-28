// /api/send-save-link.js
// Vercel Serverless Function — Sends a "Save Your Progress" magic link via HubSpot.
// Creates/updates a HubSpot contact, then sends a transactional email or adds a note.

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBSPOT_BASE = 'https://api.hubapi.com';
const HUBSPOT_OWNER_ID = '89511141';

async function hsPost(endpoint, body, method = 'POST') {
  const res = await fetch(`${HUBSPOT_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(`HubSpot ${method} ${endpoint}: ${res.status} — ${text.slice(0, 300)}`);
  }
  return data;
}

async function hsGet(endpoint) {
  const res = await fetch(`${HUBSPOT_BASE}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${HUBSPOT_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot GET ${endpoint}: ${res.status} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function findOrCreateContact(email, name) {
  // Search for existing contact
  try {
    const searchBody = {
      filterGroups: [{
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
      }],
      properties: ['email', 'firstname', 'lastname', 'hs_object_id'],
      limit: 1,
    };
    const searchResult = await hsPost('/crm/v3/objects/contacts/search', searchBody);
    if (searchResult.total > 0) {
      return searchResult.results[0].id;
    }
  } catch (e) {
    console.warn('Contact search failed:', e.message);
  }

  // Create new contact
  const nameParts = (name || '').trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const contact = await hsPost('/crm/v3/objects/contacts', {
    properties: {
      email,
      firstname: firstName,
      lastname: lastName,
      hubspot_owner_id: HUBSPOT_OWNER_ID,
      hs_lead_status: 'NEW',
      lifecyclestage: 'lead',
    }
  });

  return contact.id;
}

async function createEngagementNote(contactId, email, magicUrl, name) {
  // Create a note engagement with the magic link
  const noteBody = {
    properties: {
      hs_note_body: `AOP Visualizer — Save Progress Link\n\nContact: ${name || email}\nEmail: ${email}\n\nMagic Link (click to restore their session):\n${magicUrl}\n\nSent: ${new Date().toISOString()}`,
      hs_timestamp: Date.now().toString(),
    },
    associations: [
      {
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
      }
    ]
  };

  await hsPost('/crm/v3/objects/notes', noteBody);
}

// Try to send a transactional email via HubSpot Single Send API
async function sendTransactionalEmail(email, name, magicUrl) {
  // HubSpot Single Send API requires a pre-created template.
  // We'll try a simple approach — if it fails we fall back to the note.
  const emailBody = {
    emailId: process.env.HUBSPOT_SAVE_LINK_EMAIL_ID, // optional env var for template ID
    message: {
      to: email,
      from: 'hello@artofpossible.com',
      replyTo: 'calvin@bdigitalpartners.com',
    },
    customProperties: [
      { name: 'magic_url', value: magicUrl },
      { name: 'recipient_name', value: name || 'there' },
    ],
  };

  if (!process.env.HUBSPOT_SAVE_LINK_EMAIL_ID) {
    throw new Error('No email template ID configured');
  }

  await hsPost('/marketing/v3/transactional/single-email/send', emailBody);
}

// Fallback: send email via Gmail-style simple API (if configured)
// For v1, we'll use a hardcoded HTML note approach via HubSpot

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { email, name, sessionUrl, statePreview } = body;

  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  if (!HUBSPOT_API_KEY) {
    // In dev/preview mode, just return success
    console.log('No HubSpot API key — mock send to:', email, sessionUrl);
    return res.status(200).json({
      success: true,
      mock: true,
      message: 'Magic link would be sent (HubSpot not configured)',
    });
  }

  try {
    // Step 1: Find or create HubSpot contact
    const contactId = await findOrCreateContact(email, name);

    // Step 2: Add a note with the magic link
    await createEngagementNote(contactId, email, sessionUrl, name);

    // Step 3: Try transactional email (optional — fails gracefully)
    let emailSent = false;
    try {
      await sendTransactionalEmail(email, name, sessionUrl);
      emailSent = true;
    } catch (e) {
      console.warn('Transactional email failed, note created:', e.message);
    }

    // Step 4: Update contact with last save date
    try {
      await hsPost(`/crm/v3/objects/contacts/${contactId}`, {
        properties: {
          aop_last_saved: new Date().toISOString().split('T')[0],
          aop_session_url: sessionUrl,
        }
      }, 'PATCH');
    } catch (e) {
      console.warn('Contact property update failed:', e.message);
    }

    return res.status(200).json({
      success: true,
      contactId,
      emailSent,
      message: emailSent
        ? `Magic link sent to ${email}`
        : `Progress saved. Check with your AOP advisor for your saved link.`,
    });

  } catch (error) {
    console.error('send-save-link error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
