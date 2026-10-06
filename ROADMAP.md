# WeatherOrNot roadmap

The goal: a free daily weather game that UK friend groups play every morning and share in their group chats. We test with 20 to 30 people before pushing it anywhere bigger.

Status key: ✅ done · 🔨 in progress · ⏭ next · 💭 later

## Done so far

- ✅ Daily game: 3 yes/no calls on tomorrow's weather, locked at local midnight, settled from real observed weather
- ✅ Guest play (no signup), saved accounts, streaks, weekly city leaderboards, leagues with invite links
- ✅ Share grid, link-preview image, installable on a phone's home screen
- ✅ Design review quick wins (contrast, type, layout, feedback on picks)
- ✅ UK tailoring (°C, mph, UK cities first, British copy)
- ✅ Verified against live Open-Meteo data, with retries for outages and rate limits

## Phase 1: Fix the core game ✅

**Problem:** copying the forecast is the best strategy. The forecast is right most days, so copying it scores well. The +10 "beat the forecast" bonus doesn't pay enough to outweigh the extra misses. If everyone copies, everyone scores the same, and there's nothing to talk about. See "Why the game needs to change" below.

- [x] Set lines *at* the forecast, so the forecast itself is a coin flip on every question ("Will Manchester top 17.5°C?" when the forecast says 17.5°C), with rain paying odds from a calibrated table
- [x] ~~Nearest guess~~ dropped: on real data copying the forecast wins it. Replaced by a daily ★ banker (one call counts double), which spreads scores without rewarding copying
- [x] Rebalance scoring: odds for rain, 10 for lines, banker doubles, exact hits on a line are void (5 each). The "beat the forecast" and "bold call" bonuses are gone
- [x] Simulator (`npm run simulate`): leagues of copiers, random guessers, contrarians and players with a small local edge, over 2,000 simulated months
- [x] Rerun the simulator on real UK forecasts vs outcomes (`npm run simulate -- --real`): 14 UK cities, 6 Aug to 4 Oct 2026
- [x] Calibrate each city's lines from its last 30 settled games, leaning on a UK-wide prior until it has history
- [x] Simulator now runs the game's own question and scoring code

**Result on real UK data (what shipped):** with calibrated lines, the temperature line came out YES on 52% of days and the wind line on 50% (exactly on the forecast they were 62% and 35%). Copying the forecast scores 19.9 points a day against 19.3 for random guessing, so it's no longer a strategy. Players with even a small genuine edge still pull ahead over a month.

**Still to watch in the friends test:** rain is a long shot (YES pays up to 50) on the ~40% of days with a dry forecast, so that call is fairly dead on dry days. If it feels flat, try a different second rain question on those days.

**Simulator findings (synthetic UK autumn weather):**

| | Current design | Lines on the forecast (3 calls) | Lines on the forecast + nearest guess |
|---|---|---|---|
| Copier vs random guesser, points a day | 23.7 vs 19.0 | 14.9 vs 14.5 | 26.8 vs 21.1 |
| Days where the top score is shared | 71% | 63% | 13% |

- Confirmed: today, copying the forecast is worth about 25% more than guessing, and everyone who copies gets the same score, so most days end in a tie at the top.
- Putting the line on the forecast removes copying's advantage on the three calls: copying is no better than guessing.
- The nearest guess is what breaks the ties. It brings back a small edge for copying (the forecast is a sensible guess) but you only win the day by getting closer than everyone else.
- In every design, anyone who genuinely knows better than the forecast wins the month. With lines on the forecast, everyone else is on an equal footing day to day.

**Real UK data (14 cities, 60 days each):**

| | Current design | Lines on the forecast (3 calls) | Lines on the forecast + nearest guess |
|---|---|---|---|
| Copier vs random guesser, points a day | 23.9 vs 18.8 | 15.1 vs 14.9 | 31.1 vs 21.5 |
| Days where the top score is shared | 71% | 61% | 16% |

- The next-day rain forecast was right on 82% of days. Highs were off by 0.62°C on average and within 1°C on 84% of days. (This compares the model's day-before run with its own latest values, which is also how the game settles, so it slightly flatters the forecast compared with weather stations.)
- The synthetic results hold: the current design rewards copying, and putting the line on the forecast removes that on the three calls.
- **New problem:** real forecasts are so good at the daily high that copying wins the nearest guess easily (31.1 vs 30.4 for the "local knowledge" players). The nearest guess needs reworking before we build it.
- **Forecast bias:** in 11 of 14 cities the high beat the forecast more often than not (London 65% of days, Brighton 70%, Edinburgh 67%, Manchester the exception at 45%). Gusts came in about 1 mph under the forecast almost everywhere. With a line exactly on the forecast, "always say yes to warmer" would win about 65% of the time in London. We should shift each city's lines by its recent bias, so the calls stay genuine coin flips.

## Phase 1b: Settle on real measurements ✅ (except the production data source)

**Problem:** the game settles on Open-Meteo's "actual" values, which are the weather model's own best estimate for that grid square, not what an instrument measured. Checked against the Ronaldsway Airport station (Isle of Man) for 47 days: the model's high was typically 0.64°C off (and ran 0.3°C cold), and it agreed with the station on rain yes/no on 85% of days. That's close, but our lines sit right on the forecast, so small gaps decide calls: settling on the station instead would have changed about 1 in 4 temperature and wind answers and about 1 in 7 rain answers.

- [x] Map each place to its nearest official weather stations within 50 km (158 UK, Isle of Man and Channel Islands stations from NOAA's station list); the game tries them nearest first
- [x] Settle on that station's hourly SYNOP reports (high, rainfall, peak gust). Waits until 2 hours after midnight, retries every 30 minutes, and falls back to the model only if no station has a complete day after 36 hours
- [x] Recalibrate rain odds and line bias against station data (`npm run simulate -- --real --station`): highs at stations run 0.35°C above the forecast, gusts 0.2 mph above, and rain is more likely at low forecast amounts than the model suggested. Calibrated lines now come out YES 53% (temperature) and 52% (wind); copying scores 18.6 a day vs 19.3 for guessing
- [x] Every result says where it came from ("Measured at Ronaldsway Airport weather station, 12 km away")
- [ ] Production data source: Met Office Weather DataHub Land Observations (free tier: 360 calls a day, hourly data, 48 hours of history, ~150 UK stations). Check it has rainfall and gusts and whether it covers the Isle of Man and Channel Islands; keep OGIMET as the backup
- [x] Towns must be within 45 km of a weather station to be played (keeps Bristol, 42 km); search shows too-far towns greyed out with the distance
- [x] "Something look wrong? Tell us" on results, reviewed on an admin page (`/admin.html`, needs `ADMIN_TOKEN`). Scrapping a question voids it for everyone (5 pts, 10 if doubled) and recalculates scores
- [ ] Met Office DataHub key: waiting for the owner to register and add `METOFFICE_API_KEY` to the environment
- [x] Live test of a Douglas game: settled on Ronaldsway's reports in under a second. On 5 Oct the model said 17.4°C, the station measured 18.1°C, against a 17.8°C line, which is exactly the kind of call this fixes

## Phase 1c: First visit explains the game ✅

- [x] Designer proposal reviewed: a first-visit intro ("Reckon you can beat the forecast?") with an example card and the city picker as its button, a one-time "You vs the forecast" coach strip, clearer hints
- [x] Build the intro, with a second example card for rain (how the points work)
- [x] City chips: Manchester, Glasgow, Douglas, Belfast (Douglas replaces Cardiff), solid white for contrast; a guessed town (an Isle of Man phone) gets a one-tap "Play Douglas"
- [x] Invite links: picking your town also joins the league, in one tap
- [x] Shared results link back with the player's name, score and town: "Sam got 2 of 3 in Manchester. Your go?" with a one-tap "Play Manchester"
- [x] One-time "You vs the forecast" coach strip after the first pick
- [x] Plain-English pass on the wording: "★ Double it" instead of "banker", "+7 pts" with "Less likely = more points", no "line" or "calls", results say "It did: 18.1°C. You said Yes."
- [x] Writer's review of the new wording, then fixes ("All done" instead of "Locked in", "★ Double points", "Yes · 7 pts", results like "It hit 18.1°C. You said Yes. ✅ +20 pts", friendlier error messages)
- [x] You vs the forecast: each result shows "You 2/3 · Forecast 1/3"; the account card shows the last 30 days
- [x] Titles: last week's best forecaster in each town; each league's monthly champion; league tables are now weekly, with a shareable table
- [x] Locked to the UK, Isle of Man and Channel Islands (search offers nowhere else); each town shows its weather station before you play

## Decisions

- **Where it runs:** the UK, the Isle of Man and the Channel Islands. Not Ireland for now (it would need its own data source, km/h and a look at Irish rules), and we say "the UK, Isle of Man and Channel Islands", not "British Isles"
- **Disputes:** no per-player disputes ("it rained at my house" can't be checked and would be gamed). Players report; we scrap a question for everyone if a station reading is clearly wrong

## Phase 2: Ready for the friends test

- [ ] Hosting, with `PUBLIC_URL` set and a domain
- [ ] Database backups
- [ ] Basic, privacy-friendly analytics: do people come back the next day? Do they share?
- [x] Footer with credits, Privacy and Terms pages, "Powered by ai.doo"
- [x] Privacy and terms name ai.doo as the operator, contact hello@aidoo.biz
- [ ] Get the privacy notice and terms checked before launch
- [x] "Powered by ai.doo" links to aidoo.biz; footer has a Contact link
- [ ] Decide the Open-Meteo plan (free is non-commercial only)

## Phase 3: Bring people back

- [ ] Morning notification: "You called it ☔ 3/3" (web push)
- [ ] Animated results reveal with points counting up, then the share sheet
- [ ] "Locked in" panel that stays at the bottom of the screen with Challenge and Share
- [ ] Password reset (or sign in with a link by email)

## Phase 4: Friends test (2 weeks)

- [ ] 20 to 30 players, ideally 3 or 4 friend groups in different UK cities
- [ ] Success means: most players come back the next day without a reminder, and results get shared without being asked
- [ ] If not, change the game, not the marketing

## Phase 5: Growth 💭

- [ ] Share images generated for each player's own result
- [ ] Bigger design moves: moving rain and snow on the sky, new app icon, two-column desktop
- [ ] Specials for big weather moments: named storms, first frost, heatwaves, "white Christmas?"
- [ ] Launch into a big UK weather moment (storm season, the first snow)
- [ ] Local subreddits, city Facebook groups, weather hobbyists, "beat the local weather presenter"

## Why the game needs to change

The next-day forecast is right most of the time. Say it's right 85% of the time on a question:

| Strategy | Expected points per question |
|---|---|
| Copy the forecast | 10 × 0.85 = **8.5** |
| Go against it | 20 × 0.15 = **3.0** (plus a 5 point bonus now and then) |

Copying wins easily, so sensible players copy, everyone ends up on similar scores, and the game has no tension. The fix is to make the forecast the *line*, not the *answer*. Then the forecast is a coin flip, and what separates players is local knowledge ("it always rains more than forecast here"), reading how sure the forecast is, and gut feel.
