// One-off backfill: pulls historical FanGraphs playoff odds for every day from
// ?start=YYYY-MM-DD up to yesterday, writing each day's snapshot into Supabase.
//
// Idempotent — re-running upserts the same rows.
// Trigger by visiting: /.netlify/functions/backfill-odds?start=2026-03-26

import {
  fetchFanGraphsOdds, fanGraphsRowToDbRow,
  supabaseUpsert, getEnv,
} from '../lib/pulse-shared.mjs';

const BATCH_SIZE = 5; // 5 concurrent FanGraphs fetches at a time — polite-ish

export default async (req) => {
  const url = new URL(req.url);

  // Debug mode: ?debug=N tries several URL patterns FanGraphs may support
  // for historical odds and reports which (if any) yields data.
  const debug = url.searchParams.get('debug');
  if (debug !== null) {
    const daysAgo = parseInt(debug, 10) || 1;
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const dateStr = d.toISOString().split('T')[0];

    const patterns = [
      { name: 'dateDelta',  url: `https://www.fangraphs.com/api/playoff-odds/odds?dateDelta=${daysAgo}&projectionMode=2&standingsType=lg` },
      { name: 'date',       url: `https://www.fangraphs.com/api/playoff-odds/odds?date=${dateStr}&projectionMode=2&standingsType=lg` },
      { name: 'dateEnd',    url: `https://www.fangraphs.com/api/playoff-odds/odds?dateEnd=${dateStr}&projectionMode=2&standingsType=lg` },
      { name: 'dateBeg',    url: `https://www.fangraphs.com/api/playoff-odds/odds?dateBeg=${dateStr}&projectionMode=2&standingsType=lg` },
      { name: 'graph-team', url: `https://www.fangraphs.com/api/playoff-odds/odds-graph?team=22&season=${new Date().getFullYear()}&type=2` },
    ];

    const results = [];
    for (const p of patterns) {
      try {
        const r = await fetch(p.url);
        const text = await r.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch {}
        results.push({
          name: p.name,
          url: p.url,
          status: r.status,
          isArray: Array.isArray(parsed),
          length: Array.isArray(parsed) ? parsed.length : (parsed && typeof parsed === 'object' ? Object.keys(parsed).length : null),
          firstTeamSample: Array.isArray(parsed) && parsed[0] ? { W: parsed[0].W, L: parsed[0].L, poffTitle: parsed[0].endData?.poffTitle } : null,
          rawPreview: text.slice(0, 280),
        });
      } catch (e) {
        results.push({ name: p.name, error: String(e.message || e) });
      }
    }

    return Response.json({ daysAgo, dateStr, attempts: results });
  }

  const start = url.searchParams.get('start');
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return Response.json({ error: 'Pass ?start=YYYY-MM-DD (e.g. 2026-03-26) or ?debug=N to inspect a single day' }, { status: 400 });
  }

  const supaUrl = getEnv('SUPABASE_URL');
  const supaKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supaUrl || !supaKey) return Response.json({ error: 'Missing Supabase env' }, { status: 500 });

  const startDate = new Date(start + 'T12:00:00Z');
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const days = Math.floor((today - startDate) / 86400000);

  if (days < 1 || days > 365) {
    return Response.json({ error: `Range out of bounds (days=${days})` }, { status: 400 });
  }

  // Build the list of days-ago values, then process in batches
  const daysAgoList = Array.from({ length: days }, (_, i) => i + 1); // 1..days
  const results = [];

  for (let i = 0; i < daysAgoList.length; i += BATCH_SIZE) {
    const batch = daysAgoList.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(daysAgo => processOneDay(daysAgo, supaUrl, supaKey)));
    results.push(...batchResults);
  }

  const okCount = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  return Response.json({
    start,
    daysRequested: days,
    daysWritten: okCount,
    failedCount: failed.length,
    failures: failed.slice(0, 10), // first 10 errors for diagnostics
  });
};

async function processOneDay(daysAgo, supaUrl, supaKey) {
  const snap = new Date();
  snap.setUTCHours(12, 0, 0, 0);
  snap.setUTCDate(snap.getUTCDate() - daysAgo);
  const snapshot_date = snap.toISOString().split('T')[0];

  try {
    // dateEnd=YYYY-MM-DD is the param that actually returns historical odds
    const data = await fetchFanGraphsOdds(snapshot_date);
    const rows = data.map(t => fanGraphsRowToDbRow(t, snapshot_date)).filter(Boolean);
    if (!rows.length) return { daysAgo, snapshot_date, ok: false, error: 'no rows mapped' };
    await supabaseUpsert(supaUrl, supaKey, 'playoff_odds', rows);
    return { daysAgo, snapshot_date, ok: true, rowsWritten: rows.length };
  } catch (e) {
    return { daysAgo, snapshot_date, ok: false, error: String(e.message || e) };
  }
}
