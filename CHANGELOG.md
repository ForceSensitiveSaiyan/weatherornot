# Changelog

What changed, newest first. Not live yet: the first public version will be 1.0.0 once the friends test starts. Plans and the reasons behind them are in `ROADMAP.md`.

## Unreleased

### 6 October 2026: ready to host

- **Deploys to the ai.doo Hetzner VPS** the same way as the game scoreboards. On every push to `main`, GitHub Actions does four things:
  - runs the tests
  - writes the settings from GitHub secrets
  - copies the code to `/opt/weatherornot` and restarts it with Docker Compose
  - checks the live site

  The VPS's own Caddy serves https://playweatherornot.co.uk. The one-off setup is in `deploy/DEPLOY.md`.
- **Container** (`Dockerfile`, `compose.yaml`) with a `/healthz` health check. The game is only reachable from the server itself, on port 9890.
- **Clean restarts:** on a deploy the game finishes its requests and closes the database first. The database now runs in WAL mode.
- **Daily backups:** a full copy of the database every day, kept for 14 days (`BACKUP_DIR`, `BACKUP_KEEP`).
- **Stats on the admin page,** for each of the last 14 days:
  - players, and new players
  - how many came back the next day
  - visits, and first visits
  - shares, and visits from shared links

  Visits and shares are anonymous daily totals, with no IDs or cookies. The privacy notice says so, and says how long backups are kept.
- **Fixed:** the example in the "group chat next morning" bubble said 33 pts, a score that can't happen with that grid. It now says 34.

### 6 October 2026: QA and UI review

- A tester and a designer reviewed every page, then re-tested every fix. QA verdict: can ship. UI verdict: looks good once the "Draft" banners come off Privacy and Terms.
- **Fixed, security and crashes:**
  - two server crashes from malformed requests
  - rate limits could be dodged with a fake `X-Forwarded-For` header (now only trusted with `TRUST_PROXY`)
  - logging in failed when a guest and the account had both doubled the same game
- **Fixed, playing:**
  - answers could be split across two guest accounts on a slow connection
  - a dead end when the weather service was down (now a retry card)
  - questions stayed open on screen past midnight
  - scores didn't add up after a scrapped question
  - shared links counted a scrapped question
  - "St. Helier" (with a full stop) found the wrong place
- **Fixed, looks and access:**
  - layout overflow on 320px phones
  - contrast, including the dark-mode footer
  - keyboard and screen-reader gaps
  - no loading message for a slow town
  - about 20 smaller bugs and polish items

### 6 October 2026: first visit, footer and legal pages

- **First-visit intro, "Reckon you can beat the forecast?":**
  - two example cards showing how the questions and points work
  - one-tap town chips (Manchester, Glasgow, Douglas, Belfast)
  - a preview of what lands in the group chat
  - an Isle of Man phone gets a one-tap "Play Douglas"
- **Links from friends are one tap:**
  - an invite link joins the league when you pick your town
  - a shared result names the friend ("Sam got 2 of 3 in Manchester. Your go?")
- **Footer:** How it works, Privacy, Terms, Contact (hello@aidoo.biz), data credits, "Powered by ai.doo".
- **Privacy and Terms** name ai.doo as the operator. They're drafts until a legal check.

### 6 October 2026: settled on real weather stations

- **Results come from official weather stations** (hourly SYNOP reports via OGIMET), not the forecast model's own estimate:
  - the nearest station within 50 km is tried first
  - settlement waits 2 hours after midnight
  - the game falls back to the model only if no station has a full day after 36 hours
  - every result names its station and how far away it is
- **Towns must be within 45 km of a station** to be played. Too-far towns show greyed out with the distance.
- **"Something look wrong? Tell us"** on results. An admin page lets us scrap a question for everyone if a reading is clearly wrong.
- **Locked to the UK, the Isle of Man and the Channel Islands.** Search offers nowhere else, and each town shows its station before you play.
- **You vs the forecast:** each result shows how just copying the forecast would have done, and the account card shows the last 30 days.
- **Titles:** last week's best forecaster in each town, and each league's monthly champion. League tables are now weekly and shareable.
- **Plain-English wording throughout,** checked by a writer:
  - "★ Double points" instead of "banker"
  - "Yes · 7 pts"
  - "It hit 18.1°C. You said Yes."

### 6 October 2026: the forecast is the line, not the answer

- **Copying the forecast was the best strategy,** so everyone tied. Now every question is built around the forecast, so copying it is a coin flip:
  - rain pays odds from how often it really rained on days with that forecast
  - temperature and wind ask "over or under?" with the line on the forecast, adjusted for how each place's forecasts have been running
- **A daily ★ double** replaces the old bonuses. An exact hit on a line is void (5 pts).
- **Simulator** (`npm run simulate`) tests the design against copiers, guessers and players with local knowledge, on made-up and real UK data. Results are in `ROADMAP.md`.

### 5 October 2026: first version

- **A daily game:** 3 yes/no questions on tomorrow's weather where you live, which lock at local midnight.
- **Playing and accounts:**
  - guest play with no signup, and saved accounts
  - streaks
  - weekly town leaderboards
  - leagues with invite links
- **Sharing and looks:**
  - a spoiler-free share grid and a link-preview image
  - the page looks like tomorrow's sky
  - installable on a phone's home screen
- **Tailored for the UK:** °C, mph, UK towns first, British wording.
- **Weather fetches retry** outages and rate limits.
