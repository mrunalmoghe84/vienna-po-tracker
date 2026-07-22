import fetch from 'node-fetch';
import fs from 'fs';

const APIFY_TOKEN = process.env.APIFY_TOKEN;

if (!APIFY_TOKEN) {
  console.error('Missing APIFY_TOKEN environment variable.');
  process.exit(1);
}

// ── Resume keywords to score jobs against ────────────────────────────────────
const RESUME_KEYWORDS = [
  { keyword: 'Product Owner',        aliases: ['PO'] },
  { keyword: 'Product Management',   aliases: ['PM'] },
  { keyword: 'Agile',                aliases: ['Scrum', 'SAFe', 'Kanban'] },
  { keyword: 'Backlog Prioritisation',aliases: ['Backlog Management', 'Sprint Planning'] },
  { keyword: 'Stakeholder Management',aliases: ['Stakeholder Engagement'] },
  { keyword: 'User Story',           aliases: ['User Stories', 'SMART User Stories'] },
  { keyword: 'Product Roadmap',      aliases: ['Roadmap Planning'] },
  { keyword: 'LLM',                  aliases: ['AI', 'Machine Learning', 'Generative AI'] },
  { keyword: 'API',                  aliases: ['REST API', 'B2B API', 'Middleware'] },
  { keyword: 'iGaming',              aliases: ['Sports Betting', 'Online Gambling', 'Casino'] },
  { keyword: 'Payments',             aliases: ['Fintech', 'Payment Gateway', 'Checkout'] },
  { keyword: 'UAT',                  aliases: ['User Acceptance Testing', 'QA'] },
  { keyword: 'JIRA',                 aliases: ['Confluence', 'Atlassian'] },
  { keyword: 'Cross-functional',     aliases: ['Cross-functional Teams', 'Global Teams'] },
  { keyword: 'Data-driven',          aliases: ['Analytics', 'KPIs', 'OKRs', 'Metrics'] },
  { keyword: 'CBAP',                 aliases: ['Business Analysis', 'Requirements Engineering'] },
];

// ── Sector detection ─────────────────────────────────────────────────────────
const SECTOR_MAP = {
  'gaming':'iGaming','bet':'iGaming','casino':'iGaming','lottery':'iGaming','sport':'iGaming',
  'bank':'Fintech','fintech':'Fintech','payment':'Fintech','financial':'Fintech','insurance':'Fintech',
  'auto':'Automotive','vehicle':'Automotive','mobility':'Automotive','traffic':'Automotive',
  'un ':'Intl Org','iaea':'Intl Org','agency':'Intl Org','unido':'Intl Org','osce':'Intl Org',
};

function guessSector(title, company, desc) {
  const text = (title + ' ' + company + ' ' + (desc || '')).toLowerCase();
  for (const [k, v] of Object.entries(SECTOR_MAP)) if (text.includes(k)) return v;
  return 'Tech';
}

// ── Fit scoring ───────────────────────────────────────────────────────────────
function calcFitScore(title, kwMatchPct) {
  const t = (title || '').toLowerCase();
  const titleBonus = t.includes('product owner') ? 35
                   : t.includes('product manager') ? 28
                   : t.includes('business analyst') ? 8 : 0;
  return Math.min(100, Math.round((kwMatchPct || 0) * 0.5 + titleBonus + 8));
}

// ── Run Apify actor ───────────────────────────────────────────────────────────
async function runApifyActor() {
  console.log('Starting Apify LinkedIn scraper...');

  const runRes = await fetch('https://api.apify.com/v2/acts/cheap_scraper~linkedin-job-scraper/runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${APIFY_TOKEN}`,
    },
    body: JSON.stringify({
      keyword: ['Product Owner', 'Senior Product Owner', 'Technical Product Manager'],
      locations: ['Austria'],
      publishedAt: 'r86400',
      experienceLevel: ['associate', 'mid-senior', 'director'],
      jobFunctionInclude: ['Product Management'],
      maxItems: 150,
      saveOnlyUniqueItems: true,
      workType: ['on-site', 'hybrid'],
      resumeKeywords: RESUME_KEYWORDS,
    }),
  });

  if (!runRes.ok) {
    const err = await runRes.text();
    throw new Error(`Failed to start actor: ${runRes.status} — ${err}`);
  }

  const runData = await runRes.json();
  const runId   = runData.data?.id;
  const datasetId = runData.data?.defaultDatasetId;
  console.log(`Run started: ${runId}`);

  // ── Poll until finished ───────────────────────────────────────────────────
  let status = 'RUNNING';
  let attempts = 0;
  while (!['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(status)) {
    await new Promise(r => setTimeout(r, 8000));
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    });
    const statusData = await statusRes.json();
    status = statusData.data?.status;
    const itemCount = statusData.data?.stats?.itemCount || 0;
    console.log(`  [${++attempts}] Status: ${status} | Items so far: ${itemCount}`);
    if (attempts > 30) { console.warn('Timeout waiting for actor'); break; }
  }

  if (status !== 'SUCCEEDED') throw new Error(`Actor ended with status: ${status}`);
  console.log('Actor succeeded. Fetching results...');
  return datasetId;
}

// ── Fetch dataset items ───────────────────────────────────────────────────────
async function fetchDataset(datasetId) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&limit=200&fields=jobTitle,companyName,location,publishedAt,applyUrl,sector,contractType,experienceLevel,salaryInfo,keywordMatchScorePercentage,matchedKeywords,unmatchedKeywords,applicationsCount`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch dataset: ${res.status}`);
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const datasetId = await runApifyActor();
  const items     = await fetchDataset(datasetId);

  console.log(`Processing ${items.length} raw results...`);

  const seen = new Set();
  const jobs = [];
  let idSeq  = 1;

  for (const r of items) {
    const key = (r.jobTitle + r.companyName).toLowerCase().replace(/\s/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const title   = r.jobTitle   || '';
    const company = r.companyName || '';
    const loc     = r.location   || 'Austria';
    const city    = loc.split(',')[0].trim();

    let salary = '—';
    if (r.salaryInfo?.length >= 2) {
      const lo = Math.round(parseInt(r.salaryInfo[0].replace(/\D/g,'')) / 1000);
      const hi = Math.round(parseInt(r.salaryInfo[1].replace(/\D/g,'')) / 1000);
      if (lo && hi) salary = `${lo}–${hi}`;
    }

    jobs.push({
      id:                idSeq++,
      company,
      role:              title,
      sector:            guessSector(title, company, ''),
      posted:            (r.publishedAt || '').split('T')[0] || new Date().toISOString().split('T')[0],
      salary,
      city,
      platform:          'LinkedIn',
      url:               r.applyUrl || '',
      status:            'Not applied',
      fitScore:          calcFitScore(title, r.keywordMatchScorePercentage),
      matchedKeywords:   r.matchedKeywords   || [],
      unmatchedKeywords: r.unmatchedKeywords || [],
      applicationsCount: r.applicationsCount || '',
      contractType:      r.contractType      || '',
      experienceLevel:   r.experienceLevel   || '',
    });
  }

  jobs.sort((a, b) => b.fitScore - a.fitScore);

  const output = {
    synced_at: new Date().toISOString(),
    source:    'LinkedIn via Apify (last 24h)',
    count:     jobs.length,
    jobs,
  };

  fs.writeFileSync('jobs.json', JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${jobs.length} jobs to jobs.json`);
  console.log('\nTop 5 by fit score:');
  jobs.slice(0, 5).forEach(j => console.log(`  [${j.fitScore}] ${j.company} — ${j.role}`));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
