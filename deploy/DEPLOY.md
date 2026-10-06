# Putting WeatherOrNot live on the Hetzner VPS

This works the same way as the game scoreboards (for example reactor-panic's `rpsb.aidoo.biz`):

- GitHub Actions runs the tests, copies the code to `/opt/weatherornot` on the VPS and runs it with Docker Compose.
- The game listens on `127.0.0.1:9890`, so only the server itself can reach it.
- The VPS's own Caddy, the one already serving aidoo.biz, handles HTTPS for `playweatherornot.co.uk` and passes requests to the game.

```
/opt/weatherornot/
  .env        settings, written by the deploy from GitHub secrets
  data/       the database, plus backups/ (daily copies, 14 kept)
  release/    the code, replaced on every deploy
```

These are one-off setup steps. After that, every push to `main` deploys by itself.

## 1. Point the domain at the VPS

At the registrar's DNS settings, add these records, using the same IP addresses aidoo.biz points to:

| Type | Name | Value |
|---|---|---|
| A | `@` | the VPS's IPv4 address |
| A | `www` | the VPS's IPv4 address |
| AAAA | `@` | the VPS's IPv6 address (skip if aidoo.biz hasn't got one) |
| AAAA | `www` | the VPS's IPv6 address (skip if aidoo.biz hasn't got one) |

Remove any "parking page" records the registrar added for `@` or `www`. Check it's working with `dig +short playweatherornot.co.uk`, which should print the VPS's address. That usually takes minutes, sometimes a few hours.

## 2. Prepare the VPS

SSH in as the same user the scoreboard deploys use (the `VPS_USER` secret), then:

```sh
sudo mkdir -p /opt/weatherornot && sudo chown $USER /opt/weatherornot
sudo ss -tlnp | grep ':9890 '   # no output means port 9890 is free
```

If something already uses 9890, choose another port and change it in `compose.yaml`, `deploy/Caddyfile` and `.github/workflows/deploy.yml`.

## 3. Add the site to Caddy

Add the two blocks from `deploy/Caddyfile` to the VPS's Caddyfile, alongside aidoo.biz and the scoreboards. That's usually `/etc/caddy/Caddyfile`. Then:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Caddy gets the HTTPS certificate as soon as the DNS from step 1 reaches the server. Until the game is deployed in step 5, the site shows an error; that's expected.

## 4. Add the secrets on GitHub

In this repository on GitHub, go to **Settings → Secrets and variables → Actions → New repository secret**, and add:

| Secret | Value |
|---|---|
| `VPS_HOST` | same as in reactor-panic |
| `VPS_USER` | same as in reactor-panic |
| `VPS_SSH_KEY` | same as in reactor-panic |
| `VPS_PORT` | same as in reactor-panic (the SSH port) |
| `WEATHERORNOT_ADMIN_TOKEN` | a new long random value: run `openssl rand -hex 32` and keep it in your password manager. It's the password for `/admin.html`. |
| `WEATHERORNOT_VAPID_PUBLIC_KEY` and `WEATHERORNOT_VAPID_PRIVATE_KEY` | for morning notifications. On your own machine, in this repository, run `npm run vapid-keys` and paste in the two values. Keep them in your password manager: new keys turn everyone's notifications off. Leave both out and the game simply doesn't offer notifications. |
| `METOFFICE_API_KEY` | leave this out until the Met Office account exists |

GitHub won't show you a secret's value again once it's saved. So copy the four `VPS_*` values from wherever you keep the originals, not from reactor-panic's settings page.

## 5. Deploy

Either:

- **Go live from `main`:** merge this work into a `main` branch. Every push to `main` then runs the tests and deploys.
- **Or run it by hand:** go to the **Actions** tab, choose **Deploy to VPS**, then **Run workflow**.

The run has three parts:
- **test** runs the test suite.
- **deploy** copies the code, builds the container, and waits until the game answers on the server.
- **check-live** loads https://playweatherornot.co.uk/healthz from outside.

If **deploy** fails, its log ends with the game's own last 50 lines of output.

Then check:

- https://playweatherornot.co.uk loads the game
- https://www.playweatherornot.co.uk ends up on the same address without `www`
- https://playweatherornot.co.uk/admin.html asks for the admin token and shows the stats
- Pasting the address into WhatsApp shows the preview card (the first one can take a minute)

## Day to day

| To | Do |
|---|---|
| Put out a new version | Push to `main` (or run the workflow by hand) |
| See what it's doing | On the VPS: `docker logs --tail 100 weatherornot-app-1` |
| Restart | `docker restart weatherornot-app-1` |

It restarts by itself if it crashes or the VPS reboots. Games settle by themselves every 10 minutes.

## Backups

- **Daily copies:** the game saves a copy of its database every day in `/opt/weatherornot/data/backups`, and keeps 14.
- **Off the server:** those copies are on the same disk, so keep copies somewhere else too. The simplest way is Hetzner's **Backups** for the server (Cloud console, server, Backups), which also covers aidoo.biz and the scoreboards. Or copy the folder to your own machine now and then:
  ```sh
  rsync -av USER@HOST:/opt/weatherornot/data/backups/ ./weatherornot-backups/
  ```

**To restore a backup**, on the VPS:

```sh
docker stop weatherornot-app-1
cd /opt/weatherornot/data
cp weatherornot.db weatherornot.db.before-restore
cp backups/weatherornot-YYYY-MM-DD.db weatherornot.db
rm -f weatherornot.db-wal weatherornot.db-shm
docker start weatherornot-app-1
```
