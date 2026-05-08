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
    fetch(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${isoDate(-14)}&endDate=${isoDate(7)}`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/standings?leagueId=103,104&season=${season}`).then(r => r.json()).catch(() => ({})),
    fetch(`https://dapi.cms.mlbinfra.com/v2/content/en-us/sel-t${teamId}-news-list`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/transactions?teamId=${teamId}&startDate=${isoDate(-21)}&endDate=${isoDate(0)}`).then(r => r.json()).catch(() => ({})),
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

  // Schedule → recent finished games + upcoming
  const allGames = (scheduleData.dates || []).flatMap(d => d.games.map(g => ({ ...g, _date: d.date })));
  const finished = allGames
    .filter(g => g.status.detailedState === 'Final'
      && g.teams.home.score !== undefined
      && g.teams.away.score !== undefined)
    .slice(-5);
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
  const { teamRecord, divisionName, recentGames, upcoming, headlines, ilMoves, teamId } = ctx;

  const recentLines = recentGames.map(g => {
    const isHome = g.teams.home.team.id === teamId;
    const my = isHome ? g.teams.home.score : g.teams.away.score;
    const opp = isHome ? g.teams.away.score : g.teams.home.score;
    const oppName = (isHome ? g.teams.away.team : g.teams.home.team).name;
    const result = my > opp ? 'W' : 'L';
    return `- ${g._date}: ${result} ${my}-${opp} ${isHome ? 'vs' : '@'} ${oppName}`;
  }).join('\n') || '(no recent finalized games)';

  const upcomingLines = upcoming.map(g => {
    const isHome = g.teams.home.team.id === teamId;
    const oppName = (isHome ? g.teams.away.team : g.teams.home.team).name;
    return `- ${g.gameDate.slice(0, 10)}: ${isHome ? 'vs' : '@'} ${oppName}`;
  }).join('\n') || '(no upcoming games scheduled in window)';

  return `You're a baseball analyst writing a brief, friendly status update for fans of the ${teamRecord.name}. Today's date is ${isoDate(0)}.

CURRENT RECORD: ${teamRecord.wins}-${teamRecord.losses} (.${(parseFloat(teamRecord.pct) * 1000).toFixed(0).padStart(3, '0')} pct)
DIVISION: #${teamRecord.divisionRank} in ${divisionName}, ${teamRecord.gamesBack} GB
LAST 10: ${teamRecord.lastTen}
CURRENT STREAK: ${teamRecord.streak || 'none'}

RECENT GAMES:
${recentLines}

UPCOMING GAMES:
${upcomingLines}

RECENT INJURY MOVES:
${ilMoves.length ? ilMoves.join('\n') : '(none in last 3 weeks)'}

RECENT NEWS HEADLINES:
${headlines.length ? headlines.map(h => `- ${h}`).join('\n') : '(no recent headlines)'}

Write a 2-paragraph summary (about 80-130 words total) capturing how this team is currently doing. Sound like a knowledgeable friend at a bar — natural, conversational, opinions allowed but grounded in the data. Don't use bullet points or section headers. Don't recap stats line by line. Focus on momentum, key storylines from the recent games, notable injury news, and what's coming up. Start the response immediately with the first paragraph; no preamble like "Here's a summary."`;
}
