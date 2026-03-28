// /api/dtools-opportunity.js
// Vercel Serverless Function — Creates a D-Tools Opportunity from visualizer state.

const DTOOLS_BASE = 'https://dtcloudapi.d-tools.cloud/api/v1';
const DTOOLS_API_KEY = process.env.DTOOLS_API_KEY;
const DTOOLS_BASIC_AUTH = 'RFRDbG91ZEFQSVVzZXI6MyNRdVkrMkR1QCV3Kk15JTU8Yi1aZzlV';

const DTOOLS_HEADERS = () => ({
  'X-API-Key': DTOOLS_API_KEY,
  'Authorization': `Basic ${DTOOLS_BASIC_AUTH}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
});

// AOP system → D-Tools system name mapping
const SYSTEM_MAP = {
  illumination: 'Whole Home Lighting',
  immersion: 'AV System',
  equilibrium: 'HVAC System',
  autonomy: 'Control System',
  perimeter: 'Surveillance System',
  continuity: 'Power Management System',
};

const TIER_LABELS = {
  0: 'Curated Light',
  1: 'Living Light',
  2: 'Full Spectrum',
};

async function dtoolsPost(endpoint, body) {
  const url = `${DTOOLS_BASE}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: DTOOLS_HEADERS(),
    body: JSON.stringify(body),
  });

  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`D-Tools ${endpoint} failed: ${res.status} — ${text.slice(0, 200)}`);
  }
  return data;
}

async function dtoolsGet(endpoint) {
  const url = `${DTOOLS_BASE}/${endpoint}`;
  const res = await fetch(url, { headers: DTOOLS_HEADERS() });
  if (!res.ok) throw new Error(`D-Tools GET ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function findOrCreateClient(clientName, clientEmail, clientPhone) {
  // Search for existing client by email
  try {
    const searchRes = await fetch(
      `${DTOOLS_BASE}/Clients/SearchClients?query=${encodeURIComponent(clientEmail)}&pageSize=10&pageNumber=1`,
      { headers: DTOOLS_HEADERS() }
    );
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const clients = searchData.Data || searchData.Clients || searchData.Items || (Array.isArray(searchData) ? searchData : []);
      const existing = clients.find(c =>
        (c.Email || c.EmailAddress || '').toLowerCase() === clientEmail.toLowerCase()
      );
      if (existing) {
        return existing.ClientId || existing.Id;
      }
    }
  } catch (e) {
    console.warn('Client search failed, will create new:', e.message);
  }

  // Create new client
  const nameParts = (clientName || 'Unknown Client').trim().split(' ');
  const firstName = nameParts[0] || 'Unknown';
  const lastName = nameParts.slice(1).join(' ') || '';

  const createBody = {
    FirstName: firstName,
    LastName: lastName,
    Email: clientEmail,
    Phone: clientPhone || '',
    Source: 'AOP Visualizer',
  };

  const created = await dtoolsPost('Clients/CreateClient', createBody);
  return created.ClientId || created.Id || created.Data?.ClientId;
}

function buildOpportunityNotes(selections, phase2, rooms) {
  const lines = ['=== AOP VISUALIZER SELECTIONS ===', ''];

  // Category selections
  const categoryNames = {
    illumination: 'Illumination',
    immersion: 'Immersion',
    equilibrium: 'Equilibrium',
    autonomy: 'Autonomy',
    perimeter: 'Perimeter',
    continuity: 'Continuity',
  };

  for (const [key, label] of Object.entries(categoryNames)) {
    if (selections[key]) {
      lines.push(`[${label}]: Selected`);
      if (key === 'illumination' && selections.illumination.tier !== null && selections.illumination.tier !== undefined) {
        lines.push(`  Tier: ${TIER_LABELS[selections.illumination.tier] || 'Unknown'}`);
      }
    }
  }

  lines.push('');
  lines.push('=== ROOMS & SYSTEMS ===');

  if (phase2 && phase2.rooms && phase2.roomSystems) {
    for (const room of phase2.rooms) {
      const systems = phase2.roomSystems[room.name] || [];
      if (systems.length > 0) {
        lines.push(`${room.name} (${room.floor}): ${systems.join(', ')}`);
      }
    }
  }

  return lines.join('\n');
}

function buildLineItems(selections, phase2, estimatedAmount) {
  const items = [];

  const categorySystemMap = {
    illumination: 'Whole Home Lighting',
    immersion: 'AV System',
    equilibrium: 'HVAC System',
    autonomy: 'Control System',
    perimeter: 'Surveillance System',
    continuity: 'Power Management System',
  };

  const categoryNames = Object.keys(categorySystemMap);
  const selectedCategories = categoryNames.filter(cat => {
    if (cat === 'illumination') return selections.illumination && selections.illumination.tier !== null;
    return selections[cat] && (selections[cat].selected || Object.keys(selections[cat]).length > 0);
  });

  if (selectedCategories.length === 0) return items;

  // Split estimated amount across selected categories (rough weighting)
  const weights = {
    illumination: 3,
    immersion: 2.5,
    equilibrium: 1,
    autonomy: 1.5,
    perimeter: 1.5,
    continuity: 2,
  };

  const totalWeight = selectedCategories.reduce((sum, cat) => sum + (weights[cat] || 1), 0);
  const perUnit = estimatedAmount / totalWeight;

  for (const cat of selectedCategories) {
    const weight = weights[cat] || 1;
    const amount = Math.round((perUnit * weight) / 1000) * 1000;

    items.push({
      Name: `${cat.charAt(0).toUpperCase() + cat.slice(1)} System`,
      Description: `AOP ${cat.charAt(0).toUpperCase() + cat.slice(1)} — ${categorySystemMap[cat]}`,
      Quantity: 1,
      UnitPrice: amount,
      SystemName: categorySystemMap[cat],
    });
  }

  return items;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check API key
  if (!DTOOLS_API_KEY) {
    return res.status(503).json({
      success: false,
      error: 'D-Tools API key not configured',
      mock: true,
      opportunityId: 'MOCK-' + Date.now(),
      opportunityNumber: 'AOP-MOCK-001',
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const {
    clientName,
    clientEmail,
    clientPhone,
    projectType,
    location,
    rooms,
    selections,
    estimatedAmount,
    phase2,
  } = body;

  // Validate required fields
  if (!clientName || !clientEmail) {
    return res.status(400).json({ error: 'clientName and clientEmail are required' });
  }

  try {
    // Step 1: Find or create client
    let clientId;
    try {
      clientId = await findOrCreateClient(clientName, clientEmail, clientPhone);
    } catch (e) {
      console.warn('Could not find/create client:', e.message);
      // Continue without client ID
    }

    // Step 2: Build opportunity data
    const tierLabel = selections?.illumination?.tier !== null && selections?.illumination?.tier !== undefined
      ? ` — ${TIER_LABELS[selections.illumination.tier]}`
      : '';

    const projectLabel = projectType === 'new_build' ? 'New Build' :
      projectType === 'renovation' ? 'Renovation' : (projectType || 'Custom Home');

    const opportunityName = `${clientName} — AOP ${projectLabel}${tierLabel}`;

    const notes = buildOpportunityNotes(selections || {}, phase2 || {}, rooms || []);
    const lineItems = buildLineItems(selections || {}, phase2 || {}, estimatedAmount || 0);

    const opportunityBody = {
      Name: opportunityName,
      ClientId: clientId || null,
      ClientName: clientName,
      ClientEmail: clientEmail,
      ClientPhone: clientPhone || '',
      ProjectType: projectType || 'new_build',
      Location: location || '',
      EstimatedAmount: estimatedAmount || 0,
      Notes: notes,
      Source: 'AOP Visualizer',
      Status: 'New',
      Tags: ['AOP Visualizer', projectLabel],
      LineItems: lineItems,
    };

    const result = await dtoolsPost('Opportunities/CreateOpportunity', opportunityBody);

    const opportunityId = result.OpportunityId || result.Id || result.Data?.OpportunityId || result.Data?.Id;
    const opportunityNumber = result.OpportunityNumber || result.Number || result.Data?.OpportunityNumber || `OPP-${opportunityId}`;

    return res.status(200).json({
      success: true,
      opportunityId,
      opportunityNumber,
      clientId,
      message: `Opportunity ${opportunityNumber} created in D-Tools`,
    });

  } catch (error) {
    console.error('D-Tools opportunity error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
