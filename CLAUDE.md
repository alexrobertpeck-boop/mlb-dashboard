# 162-0 (MLB Dashboard) — orientation for future Claude sessions

A personal MLB dashboard Alex built for himself and a few friends. Started as a single HTML file showing Colorado Rockies stats; grew into a multi-team app with auth, a personal tracker (stadiums / teams / games / players / pennants), and AI-generated pulses (team + league). Deployed at **162-0.com** via Netlify with a Supabase backend.

## About Alex

- Non-developer; learning as we go. Wants explanations of non-obvious decisions, not just code.
- Prefers conversational tone. Short responses. No filler.
- Push back if a request feels off — he asked for it explicitly.
- Workflow: ship small commits → push → he tests in browser → iterates. Quick cycles.
- **Git/GitHub**: always use `alexrobertpeck@gmail.com` for commits on this project. Never the `alex@baseup.com.au` email. (Already in auto-memory.)
- He doesn't have the Netlify CLI locally — he interacts with Netlify through the web dashboard.

## Tech stack

- **Frontend**: single `index.html` (vanilla HTML/CSS/JS). All inline. ~4700 lines.
- **Hosting**: Netlify. Auto-deploys on `git push` to `main` on GitHub.
- **Functions** (Netlify Functions, ESM `.mjs`):
  - `netlify/functions/team-pulse.mjs` — serves Team Pulse summaries (DB read + live-Claude fallback)
  - `netlify/functions/pulse-cron.mjs` — **scheduled function**, regenerates pulses + snapshots playoff odds, runs at `0 10,22 * * *` UTC (~6am / 6pm ET during DST)
  - `netlify/functions/backfill-odds.mjs` — one-off historical odds backfill via `?start=YYYY-MM-DD`; also has `?debug=N` for inspecting FanGraphs response shape
  - `netlify/lib/pulse-shared.mjs` — shared helpers used by team-pulse + pulse-cron + backfill-odds (data gathering, prompt building, Claude/Supabase/FanGraphs clients, team mappings)
- **Auth + DB**: Supabase. Email/password + Google OAuth. RLS enforced.
- **AI**: Anthropic Claude (Haiku 4.5 — `claude-haiku-4-5-20251001`). Called from Netlify functions, never from the frontend.
- **Maps**: Leaflet 1.9.4 with CartoDB Positron tiles for the Stadiums map.
- **External data**: MLB Stats API (`statsapi.mlb.com`), MLB.com news CMS (`dapi.cms.mlbinfra.com`), ESPN news, FanGraphs playoff odds.

## Supabase tables

All user-data tables have RLS = "user_id = auth.uid()" for select/insert/delete. Pulse tables have public-read.

| Table | Purpose | PK |
|---|---|---|
| `attended_games` | Logged games (date, game_pk, both teams, scores, notes) | id |
| `attended_stadiums` | Manually marked stadium visits | (user_id, team_id) |
| `seen_teams` | Manually marked teams seen | (user_id, team_id) |
| `bucket_list_players` | Players the user wants to see live | (user_id, player_id) |
| `seen_players` | First-time sightings of bucket list players (date, game_pk) | (user_id, player_id) |
| `team_pulse` | Cached AI summary per team | team_id |
| `mlb_pulse` | Single-row league-wide AI summary | id (always 1) |
| `playoff_odds` | Daily FanGraphs snapshot per team | (team_id, snapshot_date) |

Source-of-truth model: **logged games are canonical**. Stadiums/teams shown as visited = explicit `attended_stadiums`/`seen_teams` rows ∪ teams/stadiums derived from logged games. Click handlers lock when an item is game-derived (you can't un-mark a stadium that has a logged game).

## Netlify environment variables

- `ANTHROPIC_API_KEY` — Claude API key (secret)
- `SUPABASE_URL` — project URL, plain `https://xxx.supabase.co` (no trailing slash, no `/rest/v1`)
- `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS, **must be marked secret**

The frontend uses its own (public) anon key inline in `index.html`. Service role is server-side only.

## Architecture quirks worth knowing

- **FanGraphs historical odds**: the magic param is `dateEnd=YYYY-MM-DD`. `dateDelta=` is empty-or-nothing and **not** a days-ago offset (it returned `[]`). `date=` and `dateBeg=` are silently ignored. Use `dateEnd=` for any historical fetch.
- **FanGraphs geo-block**: the API doesn't return data outside the US in the browser, which is why we moved to server-side cron polling.
- **Pulse caching path**: `team-pulse.mjs` reads from Supabase first; only falls back to live Claude generation if the row is missing or >24h old. So a normal page load is a fast DB read.
- **Frontend cache-buster `&v=2`**: the team-pulse fetch URL has `&v=2` appended to invalidate stale entries from a previous (24h-cached) function shape. Don't remove it casually.
- **Pulse prompts forbid markdown and self-applied titles**. The frontend still renders `**bold**` defensively for any legacy cached rows. The H2 is set dynamically to `Team Pulse: [date]` / `MLB Pulse: [date]`.
- **Team Pulse is gated to logged-in users** (UI hide + skip the fetch task). MLB Pulse on the landing page also only renders when the user has saved teams.
- **Pennants**: 12 achievements, all client-side derived from existing data. Defined in the `PENNANTS` array in `index.html`. Adding a new one is ~5 lines + a `target.type` evaluator if it's a new shape.
- **Player bucket-list detection**: uses MLB boxscores. We extract the `batters` and `pitchers` arrays (players who actually played, not bench). LocalStorage caches the player-ID list per `game_pk` so we don't refetch.
- **XSS lesson**: user-typed notes are rendered with `escapeHtml()` — friend demonstrated `<style>` injection rotating the page. Anything from `attended_games.notes` or future user-input fields must go through `escapeHtml`.

## Deploy + cron

- `git push` → Netlify auto-deploys in ~30s. Deploy log under Deploys tab.
- The cron schedule is registered automatically from `export const config = { schedule }` in `pulse-cron.mjs`. Netlify must be aware of the function for it to fire.
- To manually trigger the cron: visit `https://162-0.com/.netlify/functions/pulse-cron` in a browser. Takes 20-30s, returns JSON summary.
- **Don't trust `git commit -am` for new files** — the `-a` flag only stages tracked files. Always `git add` new files explicitly. (Bit us once when `pulse-cron.mjs` didn't get committed.)

## Common operations

| Operation | How |
|---|---|
| Add a new pennant | Add object to `PENNANTS` array in `index.html`; add a `target.type` branch in `evaluatePennant` if it's a new shape |
| Add a new Supabase table | Provide Alex the SQL (with RLS), have him paste into Supabase SQL Editor before pushing code that reads from it |
| Refresh pulses immediately | Hit `/.netlify/functions/pulse-cron` in browser |
| Backfill odds from a date | Hit `/.netlify/functions/backfill-odds?start=YYYY-MM-DD` |
| Inspect a FanGraphs response | `/.netlify/functions/backfill-odds?debug=N` (N = days ago) |

## On the backlog (not started)

- **Friends / social** — discussed at length, ~15-20 hours scoped. Sketch: profile table + friend graph + RLS policies extended to friend-readable, friend-profile read-only view. Smallest interesting first step is a shareable profile URL with no follow graph. Alex paused before starting; revive when he's ready.

## Style of work he likes

- Explain the *why* on architecture decisions, especially when there are tradeoffs.
- Ask one focused question before building something big rather than guessing.
- For UI changes, ship → he refreshes → iterates. Don't over-design upfront.
- When something doesn't work, walk through the diagnosis transparently (he wants to learn, not just receive fixes).
- Acknowledge mistakes directly (the `-a` flag bug, the bad "Trigger" UI advice, the `/rest/v1` URL).
