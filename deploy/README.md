# CardVault single-server deployment

One VPS (Ubuntu 24.04, 1 vCPU / 1-2 GB is plenty), one domain, Caddy for TLS.

## Layout

- `cardvault-web/dist` -> `/var/www/cardvault` (static PWA)
- `cardvault/server`   -> `/opt/cardvault/server` (relay, loopback only)
- Caddy terminates TLS, proxies `/v1/*` + `/health`, serves the rest

The web app is built **without** `VITE_RELAY_URL`, so its relay calls are
same-origin (`/v1/...`) — no CORS needed. The mobile app bakes the relay URL
at export time:

```bash
cd cardvault
EXPO_PUBLIC_RELAY_URL=https://app.example.com npx expo export --platform all
```

## 1. Server hardening (once)

```bash
adduser deploy && usermod -aG sudo deploy    # SSH keys only
# /etc/ssh/sshd_config: PasswordAuthentication no, PermitRootLogin no
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
apt install -y unattended-upgrades
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs caddy
```

Port 8787 stays closed: the relay binds `127.0.0.1` (HOST env) and is only
reachable through Caddy.

## 2. Relay

```bash
sudo mkdir -p /opt/cardvault
rsync -av --exclude node_modules cardvault/server/ deploy@SERVER:/tmp/server/
sudo mv /tmp/server /opt/cardvault/server
cd /opt/cardvault/server && sudo npm ci --omit=dev
npx web-push generate-vapid-keys    # save both keys
```

Edit `deploy/cardvault-relay.service`: domain in CORS_ORIGINS, VAPID keys.
Leave `DEBUG_TOKEN` unset (disables `/v1/debug`). Then:

```bash
sudo cp cardvault-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cardvault-relay
```

## 3. Web app

```bash
cd cardvault-web && npm ci && npm run build     # no VITE_RELAY_URL
rsync -av dist/ deploy@SERVER:/tmp/dist/
ssh deploy@SERVER 'sudo mkdir -p /var/www/cardvault && sudo rm -rf /var/www/cardvault/* && sudo mv /tmp/dist/* /var/www/cardvault/'
```

## 4. Caddy

Edit `deploy/Caddyfile` (domain, paths), then:

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy     # cert is issued on first request
```

DNS: A record `app.example.com` -> server IP (set this before step 4).

## 5. Verify

```bash
curl -fsS https://app.example.com/health          # {"ok":true}
curl -fsI https://app.example.com/                # check HSTS + X-Frame-Options
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.example.com/v1/debug   # 404
```

Then in a browser: create vault, pair two devices, share a card, request
details/OTP, enable web push once.

## Operational notes

- Device registrations (push tokens / web-push subscriptions) are persisted
  under systemd's `StateDirectory` (`/var/lib/cardvault-relay/devices.json`)
  so a relay restart still knows how to ping phones. Pending blobs stay
  in-memory: a restart drops undelivered mail; clients re-register
  automatically on their next signed request (401 -> register -> retry).
- VAPID keys **must** come from `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in
  production. `server/vapid.json` is generated for local dev only and must
  never be copied to the server. Rotating VAPID keys invalidates existing
  web-push subscriptions (clients re-subscribe on next unlock).
- `VAPID_SUBJECT` must be a real `https:` or `mailto:` URI that you own.
  Apple's push service returns 403 for placeholders like `mailto:…@*.local`,
  and iPhone lock-screen banners never appear.
- `TRUST_PROXY=1` is required behind Caddy so rate limits use the real client
  IP. Leave it unset if the relay is reached directly.
- Update flow: rebuild web -> rsync dist; relay: rsync server dir ->
  `sudo systemctl restart cardvault-relay`.
