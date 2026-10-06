# Changelog

What changed, newest first. Not live yet: the first public version will be 1.0.0 once the friends test starts. Plans and the reasons behind them are in `ROADMAP.md`.

## Unreleased

### 6 October 2026: "All done" bar

- **Once your three are in,** a bar at the bottom of the screen says "All done" with the time left, plus Challenge (and Share result when there's one to share). It steps aside while "That's your three." or the results card is on screen, and while you're typing.

### 6 October 2026: the morning reveal

- **Your results arrive one question at a time** the first time you see them: each reading slides onto its dial, the tick or cross lands, the score counts up, then the points. After that comes the line on how you did against the forecast, and the Share button gives a nudge.
- **Tap the card to skip to the end.** The reveal only plays once, and not at all with "reduce motion" turned on.

### 6 October 2026: morning notifications

- **"You called it. 3/3 in Douglas"** arrives as a notification once your result is in, never before 7.30am. Underneath is what the station measured and how you did against the forecast. Tapping it opens the game with the result at the top.
- **Turning it on:** "Tell me my results in the morning" under "That's your three.", or in your account card, where you can also turn it off. On an iPhone it needs the game added to the Home Screen first, and the game says so.
- **Logging out turns notifications off** on that phone, so the next person doesn't get your results. Logging in moves the phone's notifications to your account.
- **Built without new dependencies:** the encryption is checked against the worked example in the Web Push standard. The server only sends to Apple's, Google's, Mozilla's and Microsoft's push services.
- **To switch it on,** add two new GitHub secrets made with `npm run vapid-keys` (see `deploy/DEPLOY.md`). Without them the game works as before, with no notifications.
- **Admin stats** now count players with notifications on, and visits from a notification each day.
- **The privacy notice** says what's kept for notifications.

### 6 October 2026: second review, simpler and more its own

A designer and a tester reviewed it for simplicity, personality and anything that felt generic. Everything they raised is done except the "later" design ideas in `ROADMAP.md`.

- **Names.** After your first answer: "What do your mates call you?" Tables, invites and shared links now show that name instead of a made-up one like SunnyMeerkat67. Passwords are only for playing on another phone, and Log in is in the footer.
- **Short share links** (`/r/CODE`) replace the long query-string links. Their WhatsApp preview says "Sam got 2 of 3 in Manchester" and what the weather did. Before the results are in, "Send to the group chat" shares a challenge link instead of the bare home page.
- **Closing the loop with a friend.** Opening a friend's link shows their result at the top (for new and returning players alike). After answering, a new player gets "Start a league with Sam". League invite previews say who invited you.
- **The real weather in the share,** in a station-report voice:
  ```
  WeatherOrNot · Douglas · Mon 5 Oct
  Ronaldsway Airport: dry, 13.7°C, gusts 40 mph
  ☔️✅⭐ 🌡️❌ 💨✅
  2/3 · 34 pts · 🔥4 · forecast 1/3
  ```
  The forecast is only mentioned when you beat it. The day replaces the game number.
- **A dial on every temperature and wind question:** the number asked in the middle, the forecast as a dot. On results, the measured reading slides onto the same dial. The long grey explanations are now one short line, or none.
- **"The Forecast" plays along** on each town's weekly table.
- **Results** lead with what the station measured, then one line on how you did against the forecast ("Two from three. The forecast got all three."). Waiting results sit above the questions, with the header readable over them. New players don't see results for a game they never played.
- **Cut:**
  - the yellow tip banner, the small heading above the headline and the feature chips
  - the "How it works" card, now a fold-out in the footer
  - the footer logo and tagline, and the repeated "free, no money" lines
  - game numbers, most decorative emoji, and exclamation marks in messages
  - corners are less rounded
- **Copy:**
  - "That's your three. Results on Thursday morning."
  - "Copied. Paste it in the group chat."
  - "Logged in."
  - "Popular towns", and "town" everywhere instead of "city"
- **Fixed:**
  - the streak stayed alive for a day after it had ended
  - the admin stats table didn't load
  - shared league tables ranked ties differently from the app
  - "Something look wrong?" came back after a reload
  - long names broke mid-word on small phones
  - a failed league join said nothing
- **After both reviewers re-checked it:**
  - the dial's labels no longer run into the number asked
  - the results dial shows just the number asked and the measured reading
  - results say the score once ("2/3", then "Same as the forecast.")
  - the header shows the day ("Wednesday")
  - a friend's or league link replaces the generic headline
  - the name box comes after "That's your three." instead of between the questions
  - "Change name" edits in place
  - the login box explains that the login name isn't always the name your mates see
  - a friend's weather line isn't repeated for players in the same town
  - "★ Doubled" sits with the outcome so titles don't wrap
- **Simulator:** a long-shot punter, weekly tables (`--days=7`) and a points cap option (`--cap`). Capping doubled long shots was tested and not adopted; the numbers are in `ROADMAP.md`.

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
