// Netlify Function: returns the cached Team Pulse for a team.
// Reads from Supabase team_pulse (populated by the daily pulse-cron). Falls back
// to live Claude generation if the row is missing or older than STALE_HOURS,
// and writes the result back to the cache for next time.
//
// Called from the dashboard as: GET /.netlify/functions/team-pulse?team=115

import {
  gatherTeamContext, buildTeamPrompt, callClaude,
  supabaseSelect, supabaseUpsert, getEnv,
} from '../lib/pulse-shared.mjs';

const STALE_HOURS = 24;

export default async (req) => {
  const url = new URL(req.url);
  const teamId = parseInt(url.searchParams.get('team'), 10);
  if (!teamId) return jsonError(400, 'Missing or invalid `team` parameter.');

  const supaUrl = getEnv('SUPABASE_URL');
  const supaKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  // Fast path: read from DB (cron should keep this fresh)
  if (supaUrl && supaKey) {
    try {
      const rows = await supabaseSelect(supaUrl, supaKey, 'team_pulse', `team_id=eq.${teamId}&select=*`);
      const row = rows?.[0];
      if (row) {
        const ageHours = (Date.now() - new Date(row.generated_at).getTime()) / 3600000;
        if (ageHours < STALE_HOURS) {
          return jsonOk({ summary: row.summary, generatedAt: row.generated_at, teamId });
        }
      }
    } catch (e) {
      console.error('DB read failed; falling back to live generation:', e);
    }
  }

  // Fallback: generate live
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!apiKey) return jsonError(500, 'AI summary is not configured (ANTHROPIC_API_KEY missing).');

  try {
    const ctx = await gatherTeamContext(teamId);
    if (!ctx.teamRecord) return jsonError(404, `Team ${teamId} not found in current standings.`);
    const prompt = buildTeamPrompt(ctx);
    const summary = await callClaude(prompt, apiKey);

    // Best-effort write-back so the next request hits the cache
    if (supaUrl && supaKey) {
      supabaseUpsert(supaUrl, supaKey, 'team_pulse', {
        team_id: teamId,
        summary,
        generated_at: new Date().toISOString(),
      }).catch(e => console.error('DB write-back failed:', e));
    }

    return jsonOk({ summary, generatedAt: new Date().toISOString(), teamId });
  } catch (err) {
    console.error('Live generation failed:', err);
    return jsonError(500, 'Unexpected error generating summary.');
  }
};

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Short browser cache; the DB row carries the real freshness signal
      'Cache-Control': 'public, max-age=300',
    },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
