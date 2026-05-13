// Netlify Scheduled Function: regenerates Team Pulse for all 30 teams + the
// MLB Pulse twice daily, writing to Supabase. Pages then read from the cache.
//
// Cron: 10:00 UTC and 22:00 UTC ≈ 6am ET / 6pm ET during DST (slightly earlier
// in winter, but most of the season is on Eastern Daylight Time).
//
// Reads ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY from env.

import {
  TEAM_IDS,
  gatherTeamContext, buildTeamPrompt,
  gatherLeagueContext, buildLeaguePrompt,
  callClaude, supabaseUpsert, getEnv,
  fetchAndStorePlayoffOdds,
  fetchAndStoreSeatGeekEvents,
} from '../lib/pulse-shared.mjs';

export const config = {
  schedule: '0 10,22 * * *',
};

export default async (req) => {
  // ?debug=seatgeek returns the raw SeatGeek response for one team, no writes.
  // Used to inspect the response shape when the normal cron writes 0 events.
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('debug') === 'seatgeek') {
      const clientId = getEnv('SEATGEEK_CLIENT_ID');
      if (!clientId) return Response.json({ error: 'SEATGEEK_CLIENT_ID not set' }, { status: 500 });
      const today = new Date().toISOString().split('T')[0];

      const variants = [
        `performers.slug=mlb-colorado-rockies&type=mlb`,
        `performers.slug=colorado-rockies`,
        `performers.slug=colorado-rockies-baseball`,
        `q=Colorado+Rockies&type=mlb`,
        `taxonomies.name=mlb&per_page=1`, // discover real slugs from one current MLB event
      ];

      const attempts = await Promise.all(variants.map(async v => {
        const u = `https://api.seatgeek.com/2/events?${v}&datetime_local.gte=${today}&per_page=2&client_id=${clientId}`;
        try {
          const r = await fetch(u);
          const text = await r.text();
          let parsed; try { parsed = JSON.parse(text); } catch {}
          return {
            query: v,
            status: r.status,
            total: parsed?.meta?.total ?? null,
            firstEvent: parsed?.events?.[0] ? {
              id: parsed.events[0].id,
              title: parsed.events[0].title,
              type: parsed.events[0].type,
              datetime_local: parsed.events[0].datetime_local,
              stats: parsed.events[0].stats,
              performers: parsed.events[0].performers?.map(p => ({
                id: p.id, slug: p.slug, name: p.name, home_team: p.home_team, type: p.type,
              })),
            } : null,
          };
        } catch (e) {
          return { query: v, error: String(e.message || e) };
        }
      }));

      return Response.json({ today, attempts });
    }
  } catch (e) {
    return Response.json({ debugError: String(e.message || e) }, { status: 500 });
  }

  const apiKey = getEnv('ANTHROPIC_API_KEY');
  const supaUrl = getEnv('SUPABASE_URL');
  const supaKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!apiKey || !supaUrl || !supaKey) {
    console.error('Missing env:', {
      hasApi: !!apiKey, hasSupaUrl: !!supaUrl, hasSupaKey: !!supaKey,
    });
    return new Response('Missing env vars', { status: 500 });
  }

  // All 30 in parallel — Haiku rate limits handle this fine
  const teamResults = await Promise.allSettled(
    TEAM_IDS.map(teamId => generateAndStoreTeamPulse(teamId, apiKey, supaUrl, supaKey))
  );

  const mlbResult = await generateAndStoreMlbPulse(apiKey, supaUrl, supaKey)
    .then(() => ({ ok: true }))
    .catch(e => { console.error('MLB pulse failed:', e); return { ok: false, error: e.message }; });

  // Playoff odds snapshot (independent of pulses — runs even if Claude fails)
  const oddsResult = await fetchAndStorePlayoffOdds(supaUrl, supaKey)
    .then(r => ({ ok: true, ...r }))
    .catch(e => { console.error('Playoff odds snapshot failed:', e); return { ok: false, error: e.message }; });

  // SeatGeek upcoming events (also independent — skip cleanly if no client id)
  const fromNetlify = (typeof Netlify !== 'undefined' && Netlify.env?.get('SEATGEEK_CLIENT_ID')) || null;
  const fromProcess = process.env['SEATGEEK_CLIENT_ID'] || null;
  const seatgeekClientId = fromNetlify || fromProcess;
  const seatgeekResult = seatgeekClientId
    ? await fetchAndStoreSeatGeekEvents(seatgeekClientId, supaUrl, supaKey)
        .then(r => ({ ok: true, ...r }))
        .catch(e => { console.error('SeatGeek snapshot failed:', e); return { ok: false, error: e.message }; })
    : {
        ok: false,
        skipped: 'SEATGEEK_CLIENT_ID not configured',
        debug: {
          fromNetlifyLen: fromNetlify ? fromNetlify.length : null,
          fromProcessLen: fromProcess ? fromProcess.length : null,
          processKeysWithSeatGeek: Object.keys(process.env || {}).filter(k => /seat/i.test(k)),
        },
      };

  const teams = teamResults.map((r, i) => ({
    teamId: TEAM_IDS[i],
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
  }));

  const okCount = teams.filter(t => t.ok).length;
  console.log(`Pulse cron: ${okCount}/${TEAM_IDS.length} teams ok, mlb: ${mlbResult.ok ? 'ok' : 'failed'}, odds: ${oddsResult.ok ? 'ok' : 'failed'}, seatgeek: ${seatgeekResult.ok ? 'ok' : (seatgeekResult.skipped ? 'skipped' : 'failed')}`);
  return Response.json({ teams, mlb: mlbResult, odds: oddsResult, seatgeek: seatgeekResult });
};

async function generateAndStoreTeamPulse(teamId, apiKey, supaUrl, supaKey) {
  const ctx = await gatherTeamContext(teamId);
  if (!ctx.teamRecord) return { teamId, skipped: 'no team record' };
  const prompt = buildTeamPrompt(ctx);
  const summary = await callClaude(prompt, apiKey);
  if (!summary) throw new Error('Empty Claude response');
  await supabaseUpsert(supaUrl, supaKey, 'team_pulse', {
    team_id: teamId,
    summary,
    generated_at: new Date().toISOString(),
  });
  return { teamId, ok: true };
}

async function generateAndStoreMlbPulse(apiKey, supaUrl, supaKey) {
  const ctx = await gatherLeagueContext();
  const prompt = buildLeaguePrompt(ctx);
  const summary = await callClaude(prompt, apiKey);
  if (!summary) throw new Error('Empty Claude response');
  await supabaseUpsert(supaUrl, supaKey, 'mlb_pulse', {
    id: 1,
    summary,
    generated_at: new Date().toISOString(),
  });
}
