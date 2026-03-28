/**
 * Manual Contact Form → HubSpot + Email Handler
 * 
 * Receives manual form submissions from the AOP Visualizer and:
 * 1. Creates/updates a HubSpot contact
 * 2. Creates a deal in the b/digital Engagements pipeline
 * 3. Logs a rich note with the experience profile data
 * 4. Creates a follow-up task assigned to Calvin
 * 5. Sends confirmation emails via Resend (to Calvin + prospect)
 * 
 * Environment Variables:
 *   HUBSPOT_API_KEY  – HubSpot private app access token
 *   RESEND_API_KEY   – Resend API key (optional — degrades gracefully)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const HUBSPOT_BASE = 'https://api.hubapi.com';
const RESEND_BASE = 'https://api.resend.com';

const HUBSPOT_PIPELINE_ID = '2120352451'; // b/digital Engagements
const DEAL_STAGE_AI_INTAKE = '3354837724';
const CALVIN_OWNER_ID = '89511141';
const CALVIN_EMAIL = 'calvin@bdigitalpartners.com';

const FROM_EMAIL_PRIMARY = 'Art of Possible <concierge@artofpossible.com>';
const FROM_EMAIL_FALLBACK = 'Art of Possible <onboarding@resend.dev>';

// ─── HubSpot API Helper ─────────────────────────────────────────────────────

async function hubspot(method, path, body = null) {
  const token = process.env.HUBSPOT_API_KEY;
  if (!token || token === 'placeholder') throw new Error('HUBSPOT_API_KEY not configured');
  
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  
  const res = await fetch(`${HUBSPOT_BASE}${path}`, opts);
  if (res.status === 204) return {};
  
  const data = await res.json();
  if (!res.ok) {
    console.error(`HubSpot ${method} ${path} [${res.status}]:`, JSON.stringify(data));
    throw new Error(`HubSpot ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

// ─── Resend Email Helper ─────────────────────────────────────────────────────

async function sendEmail(to, subject, html, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping email');
    return null;
  }

  // Try primary domain first, fall back to resend.dev
  for (const from of [FROM_EMAIL_PRIMARY, FROM_EMAIL_FALLBACK]) {
    try {
      const res = await fetch(`${RESEND_BASE}/emails`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`Email sent to ${to} from ${from}: ${data.id}`);
        return data;
      }

      const err = await res.json().catch(() => ({}));
      // If domain not verified, try fallback
      if (res.status === 403 || (err.message && err.message.includes('domain'))) {
        console.warn(`Domain issue with ${from}, trying fallback...`);
        continue;
      }
      
      console.error(`Resend error [${res.status}]:`, JSON.stringify(err));
      return null;
    } catch (e) {
      console.error(`Email send failed from ${from}:`, e.message);
      continue;
    }
  }

  console.warn('All email send attempts failed');
  return null;
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

async function createOrUpdateContact({ firstName, lastName, email, phone, location }) {
  const properties = {};
  if (firstName) properties.firstname = firstName;
  if (lastName) properties.lastname = lastName;
  if (email) properties.email = email;
  if (phone) properties.phone = phone;
  if (location) properties.city = location;
  properties.lifecyclestage = 'lead';
  properties.hs_lead_status = 'NEW';

  const existing = await findContactByEmail(email) || await findContactByPhone(phone);

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

async function createDeal({ firstName, lastName, message, experienceProfile }, contactId) {
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Manual Inquiry';
  
  const descLines = [];
  if (message) descLines.push(`Message: ${message}`);
  
  // Include experience profile data in description
  const ep = experienceProfile || {};
  if (ep.explored && ep.explored.length) {
    descLines.push(`\nExplored Categories: ${ep.explored.join(', ')}`);
  }
  if (ep.selections) {
    const sel = ep.selections;
    if (sel.illumination?.tier != null) descLines.push(`Illumination Tier: ${sel.illumination.tier === 0 ? 'Curated Light' : sel.illumination.tier === 1 ? 'Living Light' : sel.illumination.tier === 2 ? 'Full Spectrum' : sel.illumination.tier}`);
    if (sel.immersion?.cinema === 'yes') descLines.push('Cinema: Yes');
    if (sel.immersion?.listeningRoom === 'yes') descLines.push('Listening Room: Yes');
    if (sel.immersion?.musicAreas?.length) descLines.push(`Music Areas: ${sel.immersion.musicAreas.join(', ')}`);
    if (sel.equilibrium?.zones) descLines.push(`Comfort Zones: ${sel.equilibrium.zones}`);
    if (sel.perimeter?.wanted === 'yes') descLines.push(`Perimeter: Yes${sel.perimeter.depth ? ' (' + sel.perimeter.depth + ')' : ''}`);
    if (sel.continuity?.wanted === 'yes') descLines.push(`Continuity: Yes${sel.continuity.level ? ' (' + sel.continuity.level + ')' : ''}`);
  }
  if (ep.rooms && ep.rooms.length) {
    descLines.push(`\nRooms: ${ep.rooms.map(r => r.name).join(', ')}`);
  }
  if (ep.intake) {
    const i = ep.intake;
    if (i.projectType) descLines.push(`Project Type: ${i.projectType}`);
    if (i.stage) descLines.push(`Stage: ${i.stage}`);
    if (i.location) descLines.push(`Location: ${i.location}`);
    if (i.timeline) descLines.push(`Timeline: ${i.timeline}`);
    if (i.architectBuilder) descLines.push(`Architect/Builder: ${i.architectBuilder}`);
  }

  const properties = {
    dealname: `${fullName} – Manual Inquiry`,
    pipeline: HUBSPOT_PIPELINE_ID,
    dealstage: DEAL_STAGE_AI_INTAKE,
    amount: '200000',
    description: descLines.join('\n') || 'Manual form submission from AOP Visualizer',
    hubspot_owner_id: CALVIN_OWNER_ID,
    hs_next_step: 'Schedule follow-up consultation',
  };

  const deal = await hubspot('POST', '/crm/v3/objects/deals', { properties });
  console.log(`Created deal ${deal.id}: ${fullName} – Manual Inquiry`);

  if (contactId) {
    try {
      await hubspot('PUT', `/crm/v4/objects/deals/${deal.id}/associations/contacts/${contactId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]);
    } catch (err) { console.error('Deal association failed:', err.message); }
  }

  return deal;
}

// ─── Note Logging ────────────────────────────────────────────────────────────

async function logNote(formData, contactId, dealId) {
  if (!contactId) return null;

  const { firstName, lastName, email, phone, location, message, experienceProfile } = formData;
  const date = new Date().toISOString().split('T')[0];
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';

  const sections = [];
  sections.push(`<h3>📋 AOP Manual Form Submission — ${date}</h3>`);
  sections.push(`<p><strong>Name:</strong> ${fullName} | <strong>Email:</strong> ${email || 'N/A'} | <strong>Phone:</strong> ${phone || 'N/A'} | <strong>Location:</strong> ${location || 'N/A'}</p>`);

  if (message) {
    sections.push(`<h4>Message</h4><p>${message}</p>`);
  }

  const ep = experienceProfile || {};
  if (ep.explored && ep.explored.length) {
    sections.push(`<h4>Explored Categories</h4><p>${ep.explored.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ')}</p>`);
  }

  // Selections detail
  const selDetails = [];
  if (ep.selections) {
    const sel = ep.selections;
    if (sel.illumination?.tier != null) {
      const tierNames = ['Curated Light', 'Living Light', 'Full Spectrum'];
      selDetails.push(`Illumination: ${tierNames[sel.illumination.tier] || sel.illumination.tier}`);
    }
    if (sel.immersion?.cinema) selDetails.push(`Cinema: ${sel.immersion.cinema}`);
    if (sel.immersion?.listeningRoom) selDetails.push(`Listening Room: ${sel.immersion.listeningRoom}`);
    if (sel.immersion?.musicAreas?.length) selDetails.push(`Music Areas: ${sel.immersion.musicAreas.join(', ')}`);
    if (sel.equilibrium?.zones) selDetails.push(`Comfort Zones: ${sel.equilibrium.zones}`);
    if (sel.perimeter?.wanted) selDetails.push(`Perimeter: ${sel.perimeter.wanted}${sel.perimeter.depth ? ' (' + sel.perimeter.depth + ')' : ''}`);
    if (sel.continuity?.wanted) selDetails.push(`Continuity: ${sel.continuity.wanted}${sel.continuity.level ? ' (' + sel.continuity.level + ')' : ''}`);
  }
  if (selDetails.length) {
    sections.push(`<h4>Experience Selections</h4><p>${selDetails.join('<br>')}</p>`);
  }

  if (ep.rooms && ep.rooms.length) {
    sections.push(`<h4>Rooms</h4><p>${ep.rooms.map(r => `${r.name} (${r.floor})`).join(', ')}</p>`);
  }

  if (ep.intake && Object.keys(ep.intake).length) {
    const intakeLines = [];
    const i = ep.intake;
    if (i.projectType) intakeLines.push(`Project Type: ${i.projectType}`);
    if (i.stage) intakeLines.push(`Stage: ${i.stage}`);
    if (i.location) intakeLines.push(`Location: ${i.location}`);
    if (i.timeline) intakeLines.push(`Timeline: ${i.timeline}`);
    if (i.architectBuilder) intakeLines.push(`Architect/Builder: ${i.architectBuilder}`);
    if (intakeLines.length) {
      sections.push(`<h4>Project Intake</h4><p>${intakeLines.join('<br>')}</p>`);
    }
  }

  sections.push(`<p style="font-size:11px;color:#999;">Source: Manual Form | Processed: ${new Date().toISOString()}</p>`);

  const note = await hubspot('POST', '/crm/v3/objects/notes', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: sections.join('\n'),
    },
  });

  try {
    await hubspot('PUT', `/crm/v4/objects/notes/${note.id}/associations/contacts/${contactId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]);
  } catch (err) { console.error('Note-contact association failed:', err.message); }

  if (dealId) {
    try {
      await hubspot('PUT', `/crm/v4/objects/notes/${note.id}/associations/deals/${dealId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]);
    } catch (err) { console.error('Note-deal association failed:', err.message); }
  }

  console.log(`Logged note ${note.id} on contact ${contactId}`);
  return note;
}

// ─── Follow-up Task ──────────────────────────────────────────────────────────

async function createFollowUpTask({ firstName, lastName, message, experienceProfile }, contactId, dealId) {
  if (!contactId) return null;

  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Manual Inquiry';
  const ep = experienceProfile || {};
  
  const interests = (ep.explored || []).map(c => c.charAt(0).toUpperCase() + c.slice(1));
  const interestStr = interests.length ? interests.join(', ') : 'general inquiry';
  
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 1);

  const taskBody = `Manual form submission from AOP Visualizer. ${fullName} expressed interest in: ${interestStr}. ` +
    (message ? `Message: "${message}". ` : '') +
    `Review the full details in the contact notes and schedule a personal follow-up.`;

  const task = await hubspot('POST', '/crm/v3/objects/tasks', {
    properties: {
      hs_task_subject: `Follow up: ${fullName} — Manual Inquiry`,
      hs_task_body: taskBody,
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: 'MEDIUM',
      hs_timestamp: dueDate.toISOString(),
      hs_task_type: 'CALL',
      hubspot_owner_id: CALVIN_OWNER_ID,
    },
  });

  try {
    await hubspot('PUT', `/crm/v4/objects/tasks/${task.id}/associations/contacts/${contactId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }]);
  } catch (err) { console.error('Task-contact association failed:', err.message); }

  if (dealId) {
    try {
      await hubspot('PUT', `/crm/v4/objects/tasks/${task.id}/associations/deals/${dealId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }]);
    } catch (err) { console.error('Task-deal association failed:', err.message); }
  }

  console.log(`Created task ${task.id}: Follow up with ${fullName}`);
  return task;
}

// ─── Email Templates ─────────────────────────────────────────────────────────

function buildCalvinNotificationEmail(formData) {
  const { firstName, lastName, email, phone, location, message, experienceProfile } = formData;
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
  const ep = experienceProfile || {};
  const explored = (ep.explored || []).map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ') || 'None yet';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0e1015; color: #e8e4dc; padding: 40px 32px; border-radius: 12px;">
      <div style="border-bottom: 1px solid rgba(201,169,110,0.3); padding-bottom: 20px; margin-bottom: 24px;">
        <h2 style="color: #c9a96e; font-size: 22px; font-weight: 400; margin: 0;">New Lead — AOP Visualizer</h2>
        <p style="color: #6e6b63; font-size: 13px; margin: 8px 0 0;">Manual form submission · ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px 0; color: #6e6b63; font-size: 13px; width: 120px;">Name</td><td style="padding: 8px 0; color: #e8e4dc; font-size: 14px;">${fullName}</td></tr>
        <tr><td style="padding: 8px 0; color: #6e6b63; font-size: 13px;">Email</td><td style="padding: 8px 0; color: #e8e4dc; font-size: 14px;"><a href="mailto:${email}" style="color: #c9a96e;">${email}</a></td></tr>
        ${phone ? `<tr><td style="padding: 8px 0; color: #6e6b63; font-size: 13px;">Phone</td><td style="padding: 8px 0; color: #e8e4dc; font-size: 14px;"><a href="tel:${phone}" style="color: #c9a96e;">${phone}</a></td></tr>` : ''}
        ${location ? `<tr><td style="padding: 8px 0; color: #6e6b63; font-size: 13px;">Location</td><td style="padding: 8px 0; color: #e8e4dc; font-size: 14px;">${location}</td></tr>` : ''}
        <tr><td style="padding: 8px 0; color: #6e6b63; font-size: 13px;">Explored</td><td style="padding: 8px 0; color: #e8e4dc; font-size: 14px;">${explored}</td></tr>
      </table>
      ${message ? `<div style="margin-top: 20px; padding: 16px; background: rgba(255,255,255,0.04); border-radius: 8px; border-left: 3px solid #c9a96e;"><p style="color: #6e6b63; font-size: 12px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.05em;">Message</p><p style="color: #e8e4dc; font-size: 14px; line-height: 1.6; margin: 0;">${message}</p></div>` : ''}
      <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.06);">
        <a href="https://app.hubspot.com/contacts/245521253" style="display: inline-block; background: #c9a96e; color: #0e1015; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.03em;">View in HubSpot</a>
      </div>
    </div>
  `;

  const text = `New AOP Visualizer Lead: ${fullName}\nEmail: ${email}\nPhone: ${phone || 'N/A'}\nLocation: ${location || 'N/A'}\nExplored: ${explored}\nMessage: ${message || 'N/A'}`;

  return { 
    subject: `New Lead: ${fullName} — AOP Visualizer`, 
    html, 
    text 
  };
}

function buildProspectConfirmationEmail(formData) {
  const { firstName } = formData;
  const name = firstName || 'there';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0e1015; color: #e8e4dc; padding: 40px 32px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <img src="https://artofpossible.com/assets/logo-horizontal-Ch8FnEwu.png" alt="Art of Possible" style="max-width: 200px; height: auto; opacity: 0.85;">
      </div>
      <h2 style="color: #c9a96e; font-size: 24px; font-weight: 300; text-align: center; margin: 0 0 16px; font-family: Georgia, 'Times New Roman', serif;">Thank you, ${name}.</h2>
      <p style="color: #e8e4dc; font-size: 15px; line-height: 1.7; text-align: center; max-width: 460px; margin: 0 auto 28px;">We received your inquiry and are genuinely looking forward to learning about your project. Calvin will be in touch within 24 hours to schedule a conversation.</p>
      <div style="background: rgba(201,169,110,0.08); border: 1px solid rgba(201,169,110,0.15); border-radius: 10px; padding: 24px; margin: 0 auto 28px; max-width: 460px;">
        <p style="color: #c9a96e; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 12px; font-weight: 500;">What happens next</p>
        <ol style="color: #e8e4dc; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
          <li>Calvin reviews your experience profile</li>
          <li>A personal call to discuss your vision</li>
          <li>A tailored technology narrative for your home</li>
        </ol>
      </div>
      <p style="text-align: center; margin: 32px 0 0;"><a href="https://visualizer.artofpossible.com" style="color: #c9a96e; font-size: 13px; letter-spacing: 0.04em; text-decoration: none;">Return to the Experience Visualizer →</a></p>
      <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.06); text-align: center;">
        <p style="color: #6e6b63; font-size: 11px; margin: 0;">Art of Possible · Luxury Residential Technology</p>
        <p style="color: #6e6b63; font-size: 11px; margin: 4px 0 0;"><a href="https://artofpossible.com" style="color: #6e6b63;">artofpossible.com</a></p>
      </div>
    </div>
  `;

  const text = `Thank you, ${name}.\n\nWe received your inquiry and are looking forward to learning about your project. Calvin will be in touch within 24 hours to schedule a conversation.\n\nWhat happens next:\n1. Calvin reviews your experience profile\n2. A personal call to discuss your vision\n3. A tailored technology narrative for your home\n\nReturn to the Experience Visualizer: https://visualizer.artofpossible.com\n\n— Art of Possible · artofpossible.com`;

  return {
    subject: 'Art of Possible — We received your inquiry',
    html,
    text,
  };
}

// ─── Main Handler ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    const { firstName, lastName, email, phone, location, message, experienceProfile } = body;

    // Validate
    if (!email || !email.includes('@')) {
      return res.status(400).json({ status: 'error', message: 'A valid email address is required.' });
    }
    if (!firstName && !lastName) {
      return res.status(400).json({ status: 'error', message: 'Please provide your name.' });
    }

    const formData = { firstName, lastName, email, phone, location, message, experienceProfile };
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    console.log(`\n━━━ Manual form submission: ${fullName} <${email}> ━━━`);

    // Step 1: Create/update HubSpot contact
    console.log('Creating/updating contact...');
    const contact = await createOrUpdateContact(formData);
    const contactId = contact.id;

    // Step 2: Create deal
    console.log('Creating deal...');
    const deal = await createDeal(formData, contactId);

    // Step 3: Log note
    console.log('Logging note...');
    const note = await logNote(formData, contactId, deal.id);

    // Step 4: Create follow-up task
    console.log('Creating follow-up task...');
    const task = await createFollowUpTask(formData, contactId, deal.id);

    // Step 5: Send emails (non-blocking — don't fail the request if email fails)
    let emailsSent = { calvin: false, prospect: false };
    try {
      const calvinEmail = buildCalvinNotificationEmail(formData);
      const calvinResult = await sendEmail(CALVIN_EMAIL, calvinEmail.subject, calvinEmail.html, calvinEmail.text);
      emailsSent.calvin = !!calvinResult;
    } catch (e) { console.error('Calvin email failed:', e.message); }

    try {
      const prospectEmail = buildProspectConfirmationEmail(formData);
      const prospectResult = await sendEmail(email, prospectEmail.subject, prospectEmail.html, prospectEmail.text);
      emailsSent.prospect = !!prospectResult;
    } catch (e) { console.error('Prospect email failed:', e.message); }

    const response = {
      status: 'success',
      hubspot: {
        contact_id: contactId,
        deal_id: deal.id,
        note_id: note?.id || null,
        task_id: task?.id || null,
      },
      emails_sent: emailsSent,
      timestamp: new Date().toISOString(),
    };

    console.log('━━━ Success:', JSON.stringify(response));
    return res.status(200).json(response);

  } catch (error) {
    console.error('━━━ Contact form error:', error);
    return res.status(500).json({ status: 'error', message: error.message, timestamp: new Date().toISOString() });
  }
};
