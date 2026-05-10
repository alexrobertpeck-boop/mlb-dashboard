// Netlify Function: generates a 2-paragraph team summary using Claude.
// Reads ANTHROPIC_API_KEY from Netlify env vars. Caches 30 minutes at the edge.
// Called from the dashboard as: GET /.netlify/functions/team-pulse?team=115

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export default async (req) => {
  const url = new URL(req.url);
  const teamId = parseInt(url.searchParams.get('team'), 10);
  if (!teamId) {
    return jsonError(400, 'Missing or invalid `team` parameter.');
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'AI summary is not configured (ANTHROPIC_API_KEY missing on the server).');
  }

  try {
    const ctx = await gatherTeamContext(teamId);
    if (!ctx.teamRecord) {
      return jsonError(404, `Team ${teamId} not found in current standings.`);
    }
    const prompt = buildPrompt(ctx);

    const claudeRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude error:', claudeRes.status, errText);
      return jsonError(502, 'AI service returned an error. Check Netlify function logs for details.');
    }

    const claudeData = await claudeRes.json();
    const summary = claudeData.content?.[0]?.text?.trim() || 'Unable to generate summary.';

    return new Response(JSON.stringify({
      summary,
      generatedAt: new Date().toISOString(),
      teamId,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400',
        'Netlify-CDN-Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    console.error('Function error:', err);
    return jsonError(500, 'Unexpected error generating summary.');
  }
};

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isoDate(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().split('T')[0];
}

const DIVISIONS = {
  200: 'AL West', 201: 'AL East', 202: 'AL Central',
  203: 'NL West', 204: 'NL East', 205: 'NL Central',
};

async function gatherTeamContext(teamId) {
  const season = new Date().getFullYear();

  const [scheduleData, standingsData, newsData, transData] = await Promise.all([
    fetch(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${isoDate(-7)}&endDate=${isoDate(7)}&hydrate=decisions,probablePitcher`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/standings?leagueId=103,104&season=${season}`).then(r => r.json()).catch(() => ({})),
    fetch(`https://dapi.cms.mlbinfra.com/v2/content/en-us/sel-t${teamId}-news-list`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/transactions?teamId=${teamId}&startDate=${isoDate(-7)}&endDate=${isoDate(0)}`).then(r => r.json()).catch(() => ({})),
  ]);

  // Standings → record + division
  let teamRecord = null;
  let divisionName = '';
  for (const division of standingsData.records || []) {
    for (const t of division.teamRecords) {
      if (t.team.id === teamId) {
        const lastTen = t.records?.splitRecords?.find(r => r.type === 'lastTen');
        teamRecord = {
          name: t.team.name,
          wins: t.wins,
          losses: t.losses,
          pct: t.winningPercentage,
          divisionRank: t.divisionRank,
          gamesBack: t.gamesBack,
          streak: t.streak?.streakCode,
          lastTen: lastTen ? `${lastTen.wins}-${lastTen.losses}` : '',
        };
        divisionName = DIVISIONS[division.division.id] || '';
      }
    }
  }

  // Schedule → recent finished games (most recent first) + upcoming (next 3)
  const allGames = (scheduleData.dates || []).flatMap(d => d.games.map(g => ({ ...g, _date: d.date })));
  const finished = allGames
    .filter(g => g.status.detailedState === 'Final'
      && g.teams.home.score !== undefined
      && g.teams.away.score !== undefined)
    .slice(-5)
    .reverse();
  const upcoming = allGames
    .filter(g => g.status.abstractGameState === 'Preview')
    .slice(0, 3);

  // News → headlines tagged for this team
  const headlines = (newsData.items || [])
    .filter(it => it.headline && (it.tags || []).some(t => t.slug === `teamid-${teamId}`)
                                && (it.tags || []).some(t => t.slug === 'apple-news'))
    .slice(0, 4)
    .map(it => it.headline);

  // Transactions → recent IL placements
  const ilMoves = (transData.transactions || [])
    .filter(t => t.typeDesc === 'Status Change' && /injured list/i.test(t.description || '') && !/activated/i.test(t.description || ''))
    .slice(-5)
    .map(t => `${t.date}: ${t.description}`);

  return { teamRecord, divisionName, recentGames: finished, upcoming, headlines, ilMoves, teamId };
}

function buildPrompt(ctx) {
  const { teamRecord, recentGames, upcoming, headlines, ilMoves, teamId } = ctx;

  // Most-recent first; first row is the LAST GAME — the prompt anchors here
  const recentLines = recentGames.map(g => {
    const isHome = g.teams.home.team.id === teamId;
    const my = isHome ? g.teams.home.score : g.teams.away.score;
    const opp = isHome ? g.teams.away.score : g.teams.home.score;
    const oppName = (isHome ? g.teams.away.team : g.teams.home.team).name;
    const result = my > opp ? 'W' : 'L';
    const d = g.decisions || {};
    const decisionParts = [];
    if (d.winner?.fullName) decisionParts.push(`WP ${d.winner.fullName}`);
    if (d.loser?.fullName)  decisionParts.push(`LP ${d.loser.fullName}`);
    if (d.save?.fullName)   decisionParts.push(`SV ${d.save.fullName}`);
    const decisionTail = decisionParts.length ? ` (${decisionParts.join(', ')})` : '';
    return `- ${g._date}: ${result} ${my}-${opp} ${isHome ? 'vs' : '@'} ${oppName}${decisionTail}`;
  }).join('\n') || '(no recent finalized games)';

  const upcomingLines = upcoming.map(g => {
    const isHome = g.teams.home.team.id === teamId;
    const oppName = (isHome ? g.teams.away.team : g.teams.home.team).name;
    const myProb  = (isHome ? g.teams.home : g.teams.away).probablePitcher?.fullName;
    const oppProb = (isHome ? g.teams.away : g.teams.home).probablePitcher?.fullName;
    const matchup = (myProb || oppProb) ? ` (${myProb || 'TBD'} vs ${oppProb || 'TBD'})` : '';
    return `- ${g.gameDate.slice(0, 10)}: ${isHome ? 'vs' : '@'} ${oppName}${matchup}`;
  }).join('\n') || '(no upcoming games scheduled in window)';

  return `You're writing today's Team Pulse for fans of the ${teamRecord.name}. Today's date is ${isoDate(0)}.

Focus on three things, in order of importance:
1. THE LAST GAME — what happened, the moments people are still talking about, who showed up, who didn't. This is the heart of the piece.
2. THE NEXT GAME — what to watch for, the matchup, any storyline going in.
3. ANY GENUINELY RECENT NEWS — only if there's something actually new in the last day or two (an injury, a transaction, a big headline). Skip this section if nothing fits.

Don't restate the season record, division standing, or whether they're slumping/streaking — fans already know. Don't pad with generic season-context. Don't invent details that aren't in the data below. If the last game was unremarkable, lean harder into the matchup ahead.

LAST GAME (most recent first; row 1 is the game to recap):
${recentLines}

NEXT GAMES:
${upcomingLines}

RECENT INJURY MOVES (last week):
${ilMoves.length ? ilMoves.join('\n') : '(none recent)'}

RECENT NEWS HEADLINES:
${headlines.length ? headlines.map(h => `- ${h}`).join('\n') : '(no recent headlines)'}

Write 2 short paragraphs, 80-130 words total. Friendly and conversational, like a knowledgeable friend at a bar — opinions welcome but grounded in the data above. No bullet points, no headers, no stat dumps. Start immediately with the recap; no preamble.`;
}
