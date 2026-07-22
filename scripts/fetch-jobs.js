import fetch from 'node-fetch';
import fs from 'fs';

const APP_ID  = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;

if (!APP_ID || !APP_KEY) {
  console.error('Missing ADZUNA_APP_ID or ADZUNA_APP_KEY');
  process.exit(1);
}

const SEARCHES = [
  'product owner',
  'senior product owner',
  'product manager agile',
  'technical product manager',
];

const SECTOR_MAP = {
  'gaming':'iGaming','bet':'iGaming','casino':'iGaming','lottery':'iGaming',
  'bank':'Fintech','fintech':'Fintech','payment':'Fintech','financial':'Fintech','insurance':'Fintech',
  'auto':'Automotive','vehicle':'Automotive','mobility':'Automotive','ev ':'Automotive','traffic':'Automotive',
  'un ':'Intl Org','iaea':'Intl Org','agency':'Intl Org','unido':'Intl Org','osce':'Intl Org',
};

function guessSector(title, company, desc) {
  const text = (title+' '+company+' '+(desc||'')).toLowerCase();
  for (const [k, v] of Object.entries(SECTOR_MAP)) if (text.includes(k)) return v;
  return 'Tech';
}

function buildStableUrl(title, company) {
  const query = encodeURIComponent(`${title} ${company}`.trim());
  return `https://www.adzuna.at/search?q=${query}&loc=Austria`;
}

async function fetchJobs(query) {
  const url = new URL('https://api.adzuna.com/v1/api/jobs/at/search/1');
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('app_key', APP_KEY);
  url.searchParams.set('results_per_page', '20');
  url.searchParams.set('what', query);
  url.searchParams.set('where', 'Austria');  // full country, not just Wien
  url.searchParams.set('sort_by', 'date');
  const res = await fetch(url.toString());
  if (!res.ok) { console.warn(`Failed for "${query}": ${res.status}`); return []; }
  const data = await res.json();
  return data.results || [];
}

async function main() {
  const seen = new Set();
  const jobs = [];
  let idSeq = 1;

  for (const query of SEARCHES) {
    console.log(`Fetching: "${query}"...`);
    const results = await fetchJobs(query);
    for (const r of results) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (!/product owner|product manager|technical product/i.test(r.title||'')) continue;
      const title   = r.title || '';
      const company = r.company?.display_name || '';
      jobs.push({
        id:       idSeq++,
        company,
        role:     title,
        sector:   guessSector(title, company, r.description),
        posted:   (r.created||'').split('T')[0] || new Date().toISOString().split('T')[0],
        salary:   r.salary_min && r.salary_max
                    ? `${Math.round(r.salary_min/1000)}–${Math.round(r.salary_max/1000)}`
                    : '—',
        platform: 'Adzuna',
        url:      buildStableUrl(title, company),
      });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  jobs.sort((a, b) => new Date(b.posted) - new Date(a.posted));
  fs.writeFileSync('jobs.json', JSON.stringify({
    synced_at: new Date().toISOString(),
    count: jobs.length,
    jobs
  }, null, 2));
  console.log(`Wrote ${jobs.length} jobs to jobs.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
