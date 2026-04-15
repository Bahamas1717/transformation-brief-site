# Deploying the Blueprint Index pulse

This document is everything you need to get the one-question pulse live on `brief.craighortonadvisory.com/pulse`. Read it once end to end before starting. No code changes required, just configuration and a database migration.

## What you are deploying

| Piece | Path | What it does |
|---|---|---|
| Poll page | `/pulse/index.html` | One-question form in the brief brand |
| Thanks page | `/pulse-thanks/index.html` | Confirmation after submit |
| Serverless function | `/api/pulse-submit.js` | Receives the POST, writes to Supabase |
| Supabase migration | `/migrations/001_blueprint_index_responses.sql` | Creates the table, RLS policy, rollup view |

The poll page is public and indexed by search only if you remove the `noindex` meta tag. By default it is hidden from search. The thanks page is noindex + nofollow by design.

## Step 1, run the Supabase migration

Use the same Supabase project that backs `bvf-app`, different table, no collision with existing tables.

1. Open Supabase dashboard, pick the project, go to SQL Editor.
2. Paste the contents of `/migrations/001_blueprint_index_responses.sql`.
3. Run it. Confirm the new table `public.blueprint_index_responses` exists and RLS is enabled. Confirm the view `public.blueprint_index_monthly` exists.

Rollback, if ever needed:

```sql
drop view if exists public.blueprint_index_monthly;
drop table if exists public.blueprint_index_responses;
```

## Step 2, set environment variables on Vercel

The serverless function needs three env vars. Set them in the Vercel project for `transformation-brief-site`, under Settings, Environment Variables. Production only for now.

| Name | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | e.g. `https://xxxxx.supabase.co` | Same URL as bvf-app |
| `SUPABASE_SERVICE_ROLE_KEY` | the service role key from Supabase | NEVER commit this. NEVER expose to browser. Server only. |
| `ALLOWED_ORIGINS` | `https://brief.craighortonadvisory.com,https://transformation-brief-site.vercel.app` | Comma-separated allowlist for CORS |

Find the service role key in Supabase, Project Settings, API, reveal `service_role` key. This key bypasses Row-Level Security. It must never appear in any commit, in any client JavaScript, or in any log.

If you ever suspect the service role key has leaked, rotate it immediately in Supabase and update the Vercel env var. No other action needed, because the key only exists in two places.

## Step 3, deploy

Commit the four new paths:

```
git add pulse/ pulse-thanks/ api/ migrations/ DEPLOY_PULSE.md
git commit -m "add Blueprint Index pulse page, serverless handler, supabase migration"
git push
```

Vercel builds automatically. First deploy may take 60 to 90 seconds. Check the Vercel dashboard for build status.

## Step 3a, optional, add the pulse.craighortonadvisory.com short URL

LinkedIn newsletter click-through improves when the URL looks like a real destination and is memorable. `pulse.craighortonadvisory.com` is better than `brief.craighortonadvisory.com/pulse` for this purpose. Setup takes about 10 minutes across two places.

### In TransIP DNS panel

1. Log in to TransIP, go to the DNS settings for `craighortonadvisory.com`.
2. Add a new record:
   - **Type:** CNAME
   - **Name:** `pulse`
   - **Value:** `cname.vercel-dns.com.` (note the trailing dot)
   - **TTL:** default (300 or 3600 is fine)
3. Save. DNS propagation typically completes within 5 to 30 minutes.

### In Vercel project settings

1. Open the `transformation-brief-site` project in Vercel.
2. Settings, Domains, Add Domain.
3. Type `pulse.craighortonadvisory.com`, click Add.
4. Vercel will verify the CNAME record automatically. If it does not, wait for DNS to propagate and retry.

### How the routing works

The repo now includes `vercel.json` with a rewrite rule: when the hostname is `pulse.craighortonadvisory.com`, the root path `/` is served the contents of `/pulse/`. Users see `pulse.craighortonadvisory.com` in the address bar, they see the poll form, and they submit to `/api/pulse-submit` on the same host. No redirect, no URL change, minimum friction.

All other hostnames (the brief subdomain, the vercel.app fallback) continue to serve the root home page and expose the poll at `/pulse/`.

### Update ALLOWED_ORIGINS env var

Once the short domain is live, add it to the `ALLOWED_ORIGINS` env var on Vercel so the serverless function accepts submissions from it too:

```
https://brief.craighortonadvisory.com,https://pulse.craighortonadvisory.com,https://transformation-brief-site.vercel.app
```

Redeploy or wait for the next build. The function picks up env var changes on the next cold start.

## Step 4, smoke test

1. Open `https://brief.craighortonadvisory.com/pulse` (or the vercel preview URL).
2. Pick an option, click Submit. You should land on `/pulse-thanks`.
3. Open Supabase, go to Table Editor, `blueprint_index_responses`. One row should be present.
4. Try to submit again on the same browser. You should see the 429 "already submitted" message. Refresh, still blocked within 5 minutes. This is the in-memory rate limit plus the anon token.
5. Open the page in an incognito window. Submit. A second row appears.

If any step fails, check the Vercel function logs, Project, Logs, filter to `pulse-submit`. The function logs config errors, shape errors, and upstream errors distinctly.

## Step 5, add the button to the brief

Once the smoke test passes, add a single call-to-action block to the subscribe section of `/index.html`. Example markup that matches the brief brand:

```html
<div style="margin-top: 32px;">
  <p style="color: var(--white); font-size: 14px; letter-spacing: 0.04em; margin-bottom: 12px;">
    Or take the 15-second pulse, your answer shapes this month's Blueprint Index.
  </p>
  <a href="/pulse" class="btn-secondary" style="background: var(--white); color: var(--orange); border: none;">
    Take the one-question pulse
  </a>
</div>
```

Place this below the existing "Subscribe on LinkedIn" button in the `subscribe` section. Keep it secondary, not primary. Primary CTA on the home page remains the newsletter subscribe. The pulse is a supporting ask.

## Step 6, weekly maintenance

Every Friday, the `transformation-brief-weekly` skill updates three lines in `/pulse/index.html`:

- `<p class="meta">Issue 04, April 2026. Governance driver.</p>` becomes the current issue and driver label.
- `<h1 id="question">...</h1>` becomes the current month's question.
- the four `<label class="option">` rows become the current month's answer options.
- the `POLL` config block at the bottom of the page is rewritten with the new `driver`, `question_id`, `issue_number`.

This can be done by hand (5 minutes) or automated inside the skill's Step 4a. The skill already knows which driver is current based on the rotation in `transformation-brief-weekly/blueprint-index/questions.md` (to be added when you lock the six questions).

## Step 7, rollup once a month

The friday skill queries the `blueprint_index_monthly` view via Supabase REST, aggregates the results for the month that just closed, and writes the Blueprint Index paragraph into the lead signal or a dedicated Blueprint Index block.

Example query the skill runs:

```sql
select driver, question_id, answer, response_count
from public.blueprint_index_monthly
where month = date_trunc('month', now() - interval '1 day')
order by response_count desc;
```

The headline is the top response count divided by the total for that question.

## Security notes

- The anon key is not used anywhere in the pulse flow. The page posts to our function, which uses the service role key. Nothing touches the browser that could be replayed to read or write the table.
- Responses are anonymous by design. The only persistent identifier is `anon_token`, a random UUID stored in `localStorage`, used only to prevent the same device from answering the same question twice. It cannot be reversed to a person.
- `user_agent` is stored truncated to 256 chars for debugging a browser-specific submission failure. It is not used for analytics. Delete the column if you prefer zero-UA storage, the rest of the pipeline works without it.
- CORS is allowlisted to the two known origins. Anyone posting from another origin gets a CORS rejection.
- The function has a soft in-memory rate limit of one submission per anon_token per question per 5 minutes. This is imperfect (cold starts clear it) but prevents casual abuse without a heavy dependency.

## Things i did not do (and why)

- No email capture. Response rates on anonymous polls are 3 to 5x higher than polls that capture even optional email. For month 1 we want the rate, not the list.
- No Turnstile, reCAPTCHA, or bot protection. Volume is too low to matter. Add only if we see actual bot signal in the data.
- No admin UI for viewing results. The Supabase Table Editor is sufficient for month 1. Build one only if it saves time.
- No analytics beacon. The point of the pulse is privacy. Adding Google Analytics or Plausible here would undermine the privacy claim in the page copy.

## If something breaks

1. Poll page loads but Submit fails, check Vercel function logs for `pulse-submit`.
2. Rows not appearing in Supabase, check the service role key env var is set in production, not just preview.
3. Same browser can submit twice, the rate-limit has cold-started. This is expected after long idle periods.
4. CORS rejection in browser console, check `ALLOWED_ORIGINS` matches the exact origin of the page.

Rollback is instantaneous. Delete the four new paths, redeploy, the pulse disappears. The Supabase table can stay, empty or populated, it costs nothing.
