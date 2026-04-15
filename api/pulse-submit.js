// /api/pulse-submit
//
// Vercel serverless function. Receives a poll submission from /pulse
// and writes one row into the Supabase blueprint_index_responses table.
//
// Required environment variables (set in Vercel project settings, never committed):
//   SUPABASE_URL                  e.g. https://xxxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     server-only, bypasses RLS, never sent to browser
//   ALLOWED_ORIGINS               comma-separated, e.g.
//                                 https://brief.craighortonadvisory.com,https://transformation-brief-site.vercel.app
//
// The anon key is NOT used by this function, because the table has RLS on
// and anon cannot write. This is deliberate. All writes go through here.

const ALLOWED_DRIVERS = new Set([
  'strategic-alignment',
  'leadership-culture',
  'talent',
  'data-tech',
  'change-enablement',
  'governance-risk',
]);

// Simple in-memory soft rate limit (resets on cold start, which is fine for a
// low-volume poll). Hard rate limit lives in Supabase via unique-per-token
// check below.
const recentSubmissions = new Map();
const WINDOW_MS = 5 * 60 * 1000;

function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const headers = corsHeaders(origin);
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const { driver, question_id, answer, issue_number, anon_token } = req.body || {};

    // Shape validation.
    if (
      typeof driver !== 'string' ||
      typeof question_id !== 'string' ||
      typeof answer !== 'string' ||
      !driver || !question_id || !answer
    ) {
      return res.status(400).json({ error: 'bad_shape' });
    }

    // Driver allowlist.
    if (!ALLOWED_DRIVERS.has(driver)) {
      return res.status(400).json({ error: 'bad_driver' });
    }

    // Length guardrails, prevent abuse.
    if (driver.length > 64 || question_id.length > 128 || answer.length > 256) {
      return res.status(400).json({ error: 'too_long' });
    }

    // Soft dedupe, same token submitting same question within the window.
    const dedupeKey = `${anon_token || req.headers['x-forwarded-for'] || 'unknown'}:${question_id}`;
    const last = recentSubmissions.get(dedupeKey);
    const now = Date.now();
    if (last && now - last < WINDOW_MS) {
      return res.status(429).json({ error: 'too_fast' });
    }
    recentSubmissions.set(dedupeKey, now);
    // Prune old entries opportunistically.
    if (recentSubmissions.size > 500) {
      for (const [k, t] of recentSubmissions) {
        if (now - t > WINDOW_MS) recentSubmissions.delete(k);
      }
    }

    // Config check.
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('pulse-submit, missing supabase env vars');
      return res.status(500).json({ error: 'config' });
    }

    const row = {
      driver,
      question_id,
      answer,
      issue_number: Number.isInteger(issue_number) ? issue_number : null,
      anon_token: typeof anon_token === 'string' && anon_token.length <= 64 ? anon_token : null,
      user_agent: (req.headers['user-agent'] || '').slice(0, 256),
    };

    // Write via Supabase REST, no client library needed.
    const resp = await fetch(`${url}/rest/v1/blueprint_index_responses`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('pulse-submit, supabase rejected', resp.status, text.slice(0, 300));
      return res.status(502).json({ error: 'upstream' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('pulse-submit, unexpected error', err);
    return res.status(500).json({ error: 'server' });
  }
}
