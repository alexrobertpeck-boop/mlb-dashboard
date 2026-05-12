// Shared helpers for the Team Pulse function and the daily Pulse cron.
// One copy of the data-gathering, prompt-building, Claude, and Supabase code.

export const MLB_API = 'https://statsapi.mlb.com/api/v1';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const MODEL = 'claude-haiku-4-5-20251001';

export const DIVISIONS = {
  200: 'AL West', 201: 'AL East', 202: 'AL Central',
  203: 'NL West', 204: 'NL East', 205: 'NL Central',
};

export const TEAM_IDS = [
  108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121,
  133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 158,
];

// Lookup by FanGraphs shortName / abbName → MLB team id
export const TEAM_BY_SHORT = {
  'Angels': 108, 'D-backs': 109, 'Orioles': 110, 'Red Sox': 111, 'Cubs': 112,
  'Reds': 113, 'Guardians': 114, 'Rockies': 115, 'Tigers': 116, 'Astros': 117,
  'Royals': 118, 'Dodgers': 119, 'Nationals': 120, 'Mets': 121, 'Athletics': 133,
  'Pirates': 134, 'Padres': 135, 'Mariners': 136, 'Giants': 137, 'Cardinals': 138,
  'Rays': 139, 'Rangers': 140, 'Blue Jays': 141, 'Twins': 142, 'Phillies': 143,
  'Braves': 144, 'White Sox': 145, 'Marlins': 146, 'Yankees': 147, 'Brewers': 158,
};
export const TEAM_BY_ABBR = {
  'LAA': 108, 'ARI': 109, 'BAL': 110, 'BOS': 111, 'CHC': 112, 'CIN': 113,
  'CLE': 114, 'COL': 115, 'DET': 116, 'HOU': 117, 'KC':  118, 'LAD': 119,
  'WSH': 120, 'NYM': 121, 'ATH': 133, 'OAK': 133, 'PIT': 134, 'SD':  135,
  'SEA': 136, 'SF':  137, 'STL': 138, 'TB':  139, 'TEX': 140, 'TOR': 141,
  'MIN': 142, 'PHI': 143, 'ATL': 144, 'CWS': 145, 'CHW': 145, 'MIA': 146,
  'NYY': 147, 'MIL': 158,
};

export function isoDate(daysFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().split('T')[0];
}

export function getEnv(name) {
  return (typeof Netlify !== 'undefined' && Netlify.env?.get(name)) || process.env[name];
}

// ---------- Team Pulse ----------

export async function gatherTeamContext(teamId) {
  const season = new Date().getFullYear();
  const [scheduleData, standingsData, newsData, transData] = await Promise.all([
    fetch(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${isoDate(-7)}&endDate=${isoDate(7)}&hydrate=decisions,probablePitcher`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/standings?leagueId=103,104&season=${season}`).then(r => r.json()).catch(() => ({})),
    fetch(`https://dapi.cms.mlbinfra.com/v2/content/en-us/sel-t${teamId}-news-list`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/transactions?teamId=${teamId}&startDate=${isoDate(-7)}&endDate=${isoDate(0)}`).then(r => r.json()).catch(() => ({})),
  ]);

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

  const allGames = (scheduleData.dates || []).flatMap(d => d.games.map(g => ({ ...g, _date: d.date })));
  const finished = allGames
    .filter(g => g.status?.detailedState === 'Final'
      && g.teams.home.score !== undefined
      && g.teams.away.score !== undefined)
    .slice(-5)
    .reverse();
  const upcoming = allGames
    .filter(g => g.status?.abstractGameState === 'Preview')
    .slice(0, 3);

  const headlines = (newsData.items || [])
    .filter(it => it.headline && (it.tags || []).some(t => t.slug === `teamid-${teamId}`)
                              && (it.tags || []).some(t => t.slug === 'apple-news'))
    .slice(0, 4)
    .map(it => it.headline);

  const ilMoves = (transData.transactions || [])
    .filter(t => t.typeDesc === 'Status Change' && /injured list/i.test(t.description || '') && !/activated/i.test(t.description || ''))
    .slice(-5)
    .map(t => `${t.date}: ${t.description}`);

  return { teamRecord, divisionName, recentGames: finished, upcoming, headlines, ilMoves, teamId };
}

export function buildTeamPrompt(ctx) {
  const { teamRecord, recentGames, upcoming, headlines, ilMoves, teamId } = ctx;

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
3. ANY GENUINELY RECENT NEWS — only if there's something actually new in the last day or two. Skip if nothing fits.

Don't restate the season record, division standing, or whether they're slumping/streaking — fans already know. Don't pad with generic season-context. Don't invent details that aren't in the data below. If the last game was unremarkable, lean harder into the matchup ahead.

LAST GAME (most recent first; row 1 is the game to recap):
${recentLines}

NEXT GAMES:
${upcomingLines}

RECENT INJURY MOVES (last week):
${ilMoves.length ? ilMoves.join('\n') : '(none recent)'}

RECENT NEWS HEADLINES:
${headlines.length ? headlines.map(h => `- ${h}`).join('\n') : '(no recent headlines)'}

Write 2 short paragraphs, 80-130 words total. Friendly and conversational, like a knowledgeable friend at a bar — opinions welcome but grounded in the data above. Start immediately with the recap; no preamble or title. Output plain prose only — no markdown formatting (no **bold**, no *italics*, no bullet points, no headers).`;
}

// ---------- MLB Pulse ----------

export async function gatherLeagueContext() {
  const yesterday = isoDate(-1);
  const today = isoDate(0);
  const season = new Date().getFullYear();

  const [scheduleData, standingsData, transData, newsData] = await Promise.all([
    fetch(`${MLB_API}/schedule?sportId=1&date=${yesterday}&hydrate=decisions,linescore`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/standings?leagueId=103,104&season=${season}`).then(r => r.json()).catch(() => ({})),
    fetch(`${MLB_API}/transactions?startDate=${yesterday}&endDate=${today}`).then(r => r.json()).catch(() => ({})),
    fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=12`).then(r => r.json()).catch(() => ({})),
  ]);

  const games = (scheduleData.dates?.[0]?.games || [])
    .filter(g => g.status?.detailedState === 'Final')
    .map(g => {
      const home = g.teams.home;
      const away = g.teams.away;
      const homeScore = home.score;
      const awayScore = away.score;
      const margin = Math.abs(homeScore - awayScore);
      const homeWon = homeScore > awayScore;
      const decisions = g.decisions || {};
      const innings = g.linescore?.innings || [];
      const lastInning = innings[innings.length - 1];
      const isExtra = innings.length > 9;
      const isWalkoff = homeWon && lastInning && innings.length >= 9 && (lastInning.home?.runs > 0);
      const tags = [];
      if (margin >= 8) tags.push('blowout');
      if (isExtra) tags.push(`${innings.length} innings`);
      if (isWalkoff) tags.push('possible walk-off');
      return {
        away: away.team.name,
        home: home.team.name,
        score: `${awayScore}-${homeScore}`,
        winner: homeWon ? home.team.name : away.team.name,
        wp: decisions.winner?.fullName,
        lp: decisions.loser?.fullName,
        sv: decisions.save?.fullName,
        margin,
        tags: tags.join(', '),
      };
    });

  const streaks = [];
  for (const div of standingsData.records || []) {
    for (const t of div.teamRecords) {
      const sc = t.streak?.streakCode || '';
      const len = parseInt(sc.replace(/\D/g, ''), 10) || 0;
      if (len >= 4) streaks.push({ team: t.team.name, streak: sc });
    }
  }
  streaks.sort((a, b) => parseInt(b.streak.replace(/\D/g, ''), 10) - parseInt(a.streak.replace(/\D/g, ''), 10));

  const transactions = (transData.transactions || [])
    .filter(t => t.typeDesc === 'Trade' || (t.typeDesc === 'Status Change' && /injured list/i.test(t.description || '') && !/activated/i.test(t.description || '')))
    .slice(0, 12)
    .map(t => `${t.date}: ${t.description}`);

  const headlines = (newsData.articles || [])
    .slice(0, 8)
    .map(a => a.headline || a.title || '')
    .filter(Boolean);

  return { games, streaks, transactions, headlines };
}

export function buildLeaguePrompt(ctx) {
  const { games, streaks, transactions, headlines } = ctx;

  const gamesText = games.length
    ? games.map(g => {
        const dec = [g.wp && `WP ${g.wp}`, g.lp && `LP ${g.lp}`, g.sv && `SV ${g.sv}`].filter(Boolean).join(', ');
        return `- ${g.away} @ ${g.home}, final ${g.score}, won by ${g.winner}${dec ? ` (${dec})` : ''}${g.tags ? ` — ${g.tags}` : ''}`;
      }).join('\n')
    : '(no games yesterday)';

  const streaksText = streaks.length
    ? streaks.slice(0, 6).map(s => `- ${s.team}: ${s.streak}`).join('\n')
    : '(no notable streaks)';

  const transText = transactions.length ? transactions.join('\n') : '(no significant transactions)';
  const headlinesText = headlines.length ? headlines.map(h => `- ${h}`).join('\n') : '(no headlines)';

  return `You're writing today's MLB Pulse — a daily, opinionated column for fans of the entire league. Today's date is ${isoDate(0)}. The data below covers yesterday's games and the last day's news around MLB.

Your job: read everything below and pick the 2-4 most interesting things to highlight. You're a sports columnist, not a wire service. The good stuff — a star pitcher hitting the IL, a streak ending, a walk-off win, a notable trade, a team making a statement — should rise to the top. If yesterday was quiet, say so honestly and lean into one or two storylines that are still worth talking about.

YESTERDAY'S RESULTS:
${gamesText}

ACTIVE STREAKS (4+ games):
${streaksText}

RECENT TRADES & IL MOVES:
${transText}

LEAGUE HEADLINES:
${headlinesText}

Write 2-3 short paragraphs, 100-160 words total. Conversational and opinionated, the kind of "did you see what happened last night" tone a friend would use over coffee. Don't try to cover everything — pick what's actually interesting and lean in. Start immediately with the most interesting hook; no preamble or title. Output plain prose only — no markdown formatting (no **bold**, no *italics*, no bullet points, no headers).`;
}

// ---------- FanGraphs Playoff Odds ----------

const FANGRAPHS_ODDS_URL = 'https://www.fangraphs.com/api/playoff-odds/odds';

export function fanGraphsRowToDbRow(t, snapshotDate) {
  const teamId = TEAM_BY_SHORT[t.shortName] || TEAM_BY_ABBR[t.abbName];
  if (!teamId) return null;
  const e = t.endData || {};
  return {
    team_id: teamId,
    snapshot_date: snapshotDate,
    expected_wins: round(e.ExpW),
    expected_losses: round(e.ExpL),
    playoff_pct: clamp01(e.poffTitle),
    division_pct: clamp01(e.divTitle),
    wildcard_pct: clamp01(e.wcTitle),
    ws_pct: clamp01(e.wsWin),
  };
}

// dateDelta = 0 means today, 1 means yesterday, etc.
export async function fetchFanGraphsOdds(dateDelta = 0) {
  const param = dateDelta ? String(dateDelta) : '';
  const res = await fetch(`${FANGRAPHS_ODDS_URL}?dateDelta=${param}&projectionMode=2&standingsType=lg`);
  if (!res.ok) throw new Error(`FanGraphs ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('FanGraphs returned non-array');
  return data;
}

export async function fetchAndStorePlayoffOdds(supaUrl, supaKey) {
  const data = await fetchFanGraphsOdds(0);
  const today = isoDate(0);
  const rows = data.map(t => fanGraphsRowToDbRow(t, today)).filter(Boolean);
  if (!rows.length) throw new Error('No FanGraphs rows mapped');
  await supabaseUpsert(supaUrl, supaKey, 'playoff_odds', rows);
  return { written: rows.length };
}

function round(v) { return v == null ? null : Math.round(Number(v) * 100) / 100; }
function clamp01(v) { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : Math.max(0, Math.min(1, n)); }

// ---------- Claude + Supabase ----------

export async function callClaude(prompt, apiKey, maxTokens = 700) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

function normalizeSupabaseUrl(url) {
  if (!url) return url;
  // Strip trailing slash
  let u = url.replace(/\/+$/, '');
  // If user pasted the API URL (.../rest/v1) instead of the project URL, strip it
  u = u.replace(/\/rest\/v1$/, '');
  return u;
}

export async function supabaseSelect(url, key, table, filter) {
  const base = normalizeSupabaseUrl(url);
  const res = await fetch(`${base}/rest/v1/${table}?${filter}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase select ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function supabaseUpsert(url, key, table, row) {
  const base = normalizeSupabaseUrl(url);
  const res = await fetch(`${base}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Supabase upsert ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
