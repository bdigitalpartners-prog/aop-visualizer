/**
 * One-time HubSpot Setup Script
 * Creates custom contact properties for AOP Voice Concierge data.
 * Run via: node api/setup-hubspot-properties.js
 * 
 * Requires: HUBSPOT_API_KEY environment variable
 */

const HUBSPOT_TOKEN = process.env.HUBSPOT_API_KEY;
if (!HUBSPOT_TOKEN) { console.error('Set HUBSPOT_API_KEY env var first'); process.exit(1); }
const HUBSPOT_BASE = 'https://api.hubapi.com';

async function createPropertyGroup() {
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/properties/contacts/groups`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'aop_voice_concierge',
      label: 'AOP Voice Concierge',
      displayOrder: 1,
    }),
  });
  const data = await res.json();
  if (res.ok) {
    console.log('✓ Created property group: aop_voice_concierge');
  } else if (data.category === 'CONFLICT') {
    console.log('✓ Property group already exists: aop_voice_concierge');
  } else {
    console.error('✗ Failed to create group:', data.message);
  }
}

async function createProperty(prop) {
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/properties/contacts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(prop),
  });
  const data = await res.json();
  if (res.ok) {
    console.log(`  ✓ ${prop.name} (${prop.type})`);
  } else if (data.category === 'CONFLICT') {
    console.log(`  ✓ ${prop.name} (already exists)`);
  } else {
    console.error(`  ✗ ${prop.name}: ${data.message}`);
  }
}

const PROPERTIES = [
  // Project Details
  { name: 'aop_project_type', label: 'AOP Project Type', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'New Build',value:'new_build'},{label:'Renovation',value:'renovation'},{label:'Unknown',value:'unknown'}] },
  { name: 'aop_project_stage', label: 'AOP Project Stage', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Early Concept',value:'early_concept'},{label:'Design Phase',value:'design_phase'},{label:'Drawings Complete',value:'drawings_complete'},{label:'Under Construction',value:'under_construction'},{label:'Existing Home',value:'existing_home'}] },
  { name: 'aop_has_drawings', label: 'Has Drawings', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'No',value:'no'},{label:'In Progress',value:'in_progress'},{label:'Unknown',value:'unknown'}] },
  { name: 'aop_architect_builder', label: 'Architect / Builder', type: 'string', fieldType: 'text', groupName: 'aop_voice_concierge' },
  { name: 'aop_location', label: 'Project Location', type: 'string', fieldType: 'text', groupName: 'aop_voice_concierge' },
  { name: 'aop_room_count', label: 'Estimated Room Count', type: 'string', fieldType: 'text', groupName: 'aop_voice_concierge' },
  { name: 'aop_rooms_mentioned', label: 'Rooms Mentioned', type: 'string', fieldType: 'textarea', groupName: 'aop_voice_concierge' },
  { name: 'aop_timeline', label: 'Project Timeline', type: 'string', fieldType: 'text', groupName: 'aop_voice_concierge' },

  // Lifestyle Profile
  { name: 'aop_music_lover', label: 'Music Priority', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Very Important',value:'very_important'},{label:'Somewhat Important',value:'somewhat_important'},{label:'Not Important',value:'not_important'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_film_lover', label: 'Film / Cinema Priority', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Very Important',value:'very_important'},{label:'Somewhat Important',value:'somewhat_important'},{label:'Not Important',value:'not_important'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_entertains_often', label: 'Entertains Often', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'Sometimes',value:'sometimes'},{label:'Rarely',value:'rarely'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_works_from_home', label: 'Works from Home', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'Sometimes',value:'sometimes'},{label:'No',value:'no'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_outdoor_living', label: 'Outdoor Living Priority', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Very Important',value:'very_important'},{label:'Somewhat Important',value:'somewhat_important'},{label:'Not Important',value:'not_important'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_sleep_quality', label: 'Sleep Quality Priority', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'High Priority',value:'high_priority'},{label:'Mentioned',value:'mentioned'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_wellness_interest', label: 'Wellness Interest', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'High Interest',value:'high_interest'},{label:'Some Interest',value:'some_interest'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_previous_tech', label: 'Previous Tech Experience', type: 'string', fieldType: 'textarea', groupName: 'aop_voice_concierge' },
  { name: 'aop_biggest_frustration', label: 'Biggest Frustration', type: 'string', fieldType: 'textarea', groupName: 'aop_voice_concierge' },
  { name: 'aop_dream_feature', label: 'Dream Feature', type: 'string', fieldType: 'textarea', groupName: 'aop_voice_concierge' },

  // Experience Category Selections
  { name: 'aop_illumination_tier', label: 'Illumination Tier', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Curated Light',value:'curated_light'},{label:'Living Light',value:'living_light'},{label:'Full Spectrum',value:'full_spectrum'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_cinema_interested', label: 'Cinema Interested', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'No',value:'no'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_listening_room', label: 'Listening Room Interested', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'No',value:'no'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_distributed_audio', label: 'Distributed Audio', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'No',value:'no'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_comfort_zones', label: 'Comfort Zones (Equilibrium)', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Essential (2-3)',value:'essential_2_3'},{label:'Considered (4-6)',value:'considered_4_6'},{label:'Complete (7+)',value:'complete_7_plus'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_perimeter_interested', label: 'Perimeter Interested', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'No',value:'no'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_perimeter_depth', label: 'Perimeter Depth', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Entry Points',value:'entry_points'},{label:'Full Property',value:'full_property'},{label:'Complete Awareness',value:'complete_awareness'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_continuity_interested', label: 'Continuity Interested', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Yes',value:'yes'},{label:'No',value:'no'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },
  { name: 'aop_continuity_level', label: 'Continuity Level', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Battery Backup',value:'battery_backup'},{label:'Battery + Generator',value:'battery_plus_generator'},{label:'Full Energy Intelligence',value:'full_energy_intelligence'},{label:'Undecided',value:'undecided'},{label:'Not Discussed',value:'not_discussed'}] },

  // Qualification
  { name: 'aop_project_scope', label: 'Predicted Project Scope', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Under $200K',value:'under_200k'},{label:'$200K–$500K',value:'200k_500k'},{label:'$500K–$1M',value:'500k_1m'},{label:'Over $1M',value:'over_1m'},{label:'Unclear',value:'unclear'}] },
  { name: 'aop_readiness_level', label: 'Readiness Level', type: 'enumeration', fieldType: 'select', groupName: 'aop_voice_concierge',
    options: [{label:'Ready Now',value:'ready_now'},{label:'3–6 Months',value:'3_6_months'},{label:'6–12 Months',value:'6_12_months'},{label:'Exploring',value:'exploring'},{label:'Unclear',value:'unclear'}] },
  { name: 'aop_call_summary', label: 'Last Call Summary', type: 'string', fieldType: 'textarea', groupName: 'aop_voice_concierge' },
  { name: 'aop_lead_source', label: 'AOP Lead Source', type: 'string', fieldType: 'text', groupName: 'aop_voice_concierge',
    description: 'How the lead entered the AOP funnel (voice_concierge, visualizer, etc.)' },
  { name: 'aop_last_call_date', label: 'Last Voice Call Date', type: 'date', fieldType: 'date', groupName: 'aop_voice_concierge' },
];

async function main() {
  console.log('Setting up HubSpot properties for AOP Voice Concierge...\n');
  
  await createPropertyGroup();
  console.log(`\nCreating ${PROPERTIES.length} contact properties:\n`);
  
  for (const prop of PROPERTIES) {
    await createProperty(prop);
  }
  
  console.log(`\n✓ Setup complete. ${PROPERTIES.length} properties configured.`);
}

main().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
