# Deploying the hosted connector on a DigitalOcean droplet

This guide sets up a new Ubuntu 24.04 droplet running the Lawmatics connector in hosted, multi-user mode (`TRANSPORT=http`) behind nginx with TLS, managed by PM2, and connected to Claude Enterprise as an org-level custom connector. Each user signs in as their own Lawmatics user. See "Hosted, multi-user" in [README.md](README.md) for how sign-in works.

Placeholders used throughout:

| Placeholder | Meaning |
|---|---|
| `<droplet-ip>` | The droplet's public IPv4 address |
| `<host>` | The public hostname, e.g. `lawmatics-mcp.example.duckdns.org` or a subdomain of your own domain |
| `<user>` | The non-root admin user you create in step 3 |
| `<firm-domain>` | The email domain of your firm's Lawmatics logins, e.g. `example.com` |

Run commands on the droplet unless a step says "your computer".

---

## 1. Create the droplet and DNS

1. **Droplet** (DigitalOcean console): Ubuntu 24.04 LTS x64; Basic, 2 GB RAM / 1 vCPU (1 GB works with the swap file in step 7); SSH key authentication only, no root password; enable Monitoring and weekly Backups (the backups cover the encrypted token store).
2. **DNS:** point `<host>` at `<droplet-ip>` with an A record. With DuckDNS, add the name in the DuckDNS console and set its IP; a droplet's IP does not change, so no update script is needed.
   - DuckDNS is a free third-party service: an outage or a compromised DuckDNS account takes the connector down or lets someone redirect it. For long-term client use, prefer a subdomain of the firm's own domain.
3. The host must be reachable from the public internet: Claude connectors are called from Anthropic's servers, not from users' computers.

## 2. First login: update packages

From your computer:

```bash
ssh root@<droplet-ip>
```

```bash
apt update && apt -y full-upgrade && apt -y install unattended-upgrades git curl && reboot
```

Unattended upgrades install security patches automatically. Check `timedatectl` shows `System clock synchronized: yes`; token expiry depends on an accurate clock.

## 3. Create the non-root user

Log back in as root after the reboot:

```bash
adduser <user> && usermod -aG sudo <user> && rsync --archive --chown=<user>:<user> ~/.ssh /home/<user>
```

`adduser` asks for a password: it is used for `sudo`, not for logging in.

**Before continuing**, open a second terminal on your computer and confirm both work (the second prints `root`). Keep the root session open until step 4 is confirmed.

```bash
ssh <user>@<droplet-ip>
```

```bash
sudo whoami
```

## 4. Lock down SSH: keys only, no root login

Ubuntu reads `/etc/ssh/sshd_config.d/` in alphabetical order and the **first** value for a setting wins. DigitalOcean's `50-cloud-init.conf` can re-enable passwords, so this file must sort before it:

```bash
sudo tee /etc/ssh/sshd_config.d/01-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
```

```bash
sudo sshd -t && sudo systemctl restart ssh && sudo sshd -T | grep -E "^port|permitrootlogin|passwordauthentication"
```

Expect `port 22`, `permitrootlogin no`, `passwordauthentication no`. Then confirm from a **new** terminal on your computer that root is refused ("Permission denied") before closing the old root session:

```bash
ssh root@<droplet-ip>
```

## 5. Firewall

Use a **DigitalOcean Cloud Firewall** (Networking > Firewalls) with:

| Direction | Rule |
|---|---|
| Inbound | SSH 22, HTTP 80, HTTPS 443 from all IPv4/IPv6 |
| Outbound | All TCP, all UDP, ICMP to all (DigitalOcean's default) |

If you already have a cloud firewall with these rules for another MCP droplet, add this droplet to it instead of creating a new one. Port 80 must stay open for certificate renewals and the HTTP-to-HTTPS redirect. Everything else, including the app's port 3100, is blocked; the app also listens only on `127.0.0.1`.

ufw is optional as a second layer. If you enable it, allow SSH **first** or you will lock yourself out:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

## 6. Node and PM2

Node 20 reached end-of-life on 2026-04-30 and no longer receives security patches; use Node 22 (LTS) or newer. Install Node one way only (NodeSource), not also through nvm: with two copies, one can be updated while PM2 keeps running the other.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt -y install nodejs && sudo npm install -g pm2 && node -v
```

## 7. Swap (needed on 1 GB droplets, harmless otherwise)

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 8. Lawmatics developer app

In Lawmatics (needs an account with developer settings; ask support@lawmatics.com to enable them):

1. Settings > Developers > Create New Application. Create a **new** app for the hosted connector rather than reusing one used for local installs.
2. Callback URL: `https://<host>/oauth/lawmatics/callback`, exactly.
3. Copy the Client ID and Client Secret for step 9.

Per the Lawmatics API docs, only creating the app needs developer settings; any user can then approve it for their own account.

## 9. Install the app

```bash
sudo mkdir -p /var/www/<host> && sudo chown <user>:<user> /var/www/<host>
```

```bash
cd /var/www/<host> && git clone --branch feature/http-multiuser https://github.com/ryanmarean/lawmatics-mcp-lcp.git
```

```bash
cd lawmatics-mcp-lcp && npm ci && npm run build && npm test
```

Generate the encryption key and **also save it in the firm's password manager**. Losing it disconnects every user.

```bash
openssl rand -hex 32
```

Create `.env` in the app folder (git ignores it) and restrict it:

```bash
nano .env
```

```bash
chmod 600 .env
```

```ini
TRANSPORT=http
MCP_BASE_URL=https://<host>
HOST=127.0.0.1
PORT=3100
LAWMATICS_CLIENT_ID=<from step 8>
LAWMATICS_CLIENT_SECRET=<from step 8>
LAWMATICS_MCP_ENCRYPTION_KEY=<64 hex chars>
LAWMATICS_ALLOWED_EMAIL_DOMAINS=<firm-domain>
```

- `MCP_BASE_URL` must match the public address exactly (`https`, no trailing slash), or every token is rejected.
- Confirm users' Lawmatics logins actually use `<firm-domain>`; anyone else is refused at sign-in.
- The token store (`store.enc`) and audit log go in `~/.lawmatics-mcp/` by default.

See the configuration reference in [README.md](README.md) for optional settings (token lifetimes, rate limit, redirect allowlist).

## 10. nginx and TLS

```bash
sudo apt -y install nginx certbot python3-certbot-nginx
```

```bash
sudo nano /etc/nginx/sites-available/<host>
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name <host>;
    server_tokens off;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # MCP streams responses
        proxy_read_timeout 3600s;
        client_max_body_size 30m;     # base64 file uploads
    }
}
```

Proxy the whole host, not only `/mcp`: the OAuth endpoints live at the root.

```bash
sudo ln -s /etc/nginx/sites-available/<host> /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot --nginx -d <host> --redirect
```

```bash
sudo certbot renew --dry-run
```

certbot asks for an email address and acceptance of the Let's Encrypt terms; it adds the HTTPS `listen` lines and the redirect itself, and renews from a systemd timer.

## 11. Run with PM2

From the app folder:

```bash
pm2 start build/index.js --name lawmatics-mcp-lcp --time --max-memory-restart 300M
```

```bash
pm2 logs lawmatics-mcp-lcp --lines 20
```

The startup log lists the public endpoint, the Lawmatics callback, the allowed redirect URIs and the email domains. If a setting is missing, the process exits and lists every missing setting.

Keep the default single process: **never** use `-i` or cluster mode. The token store is held in memory by one process.

Make it survive reboots and rotate logs:

```bash
pm2 install pm2-logrotate
```

```bash
pm2 startup systemd -u <user> --hp /home/<user>
```

`pm2 startup` prints a `sudo env PATH=...` command: run it, then:

```bash
pm2 save
```

```bash
chmod 700 ~/.lawmatics-mcp
```

## 12. Verify

From your computer:

```bash
curl https://<host>/health
```

```bash
curl https://<host>/.well-known/oauth-authorization-server
```

```bash
curl -i -X POST https://<host>/mcp
```

Expect `{"ok":true}`, JSON listing `/authorize`, `/token` and `/register` on your host, and HTTP 401 with a `WWW-Authenticate` header containing `resource_metadata=`.

Then reboot once (`sudo reboot`) and confirm `pm2 status` shows the app online again.

## 13. Add the connector in Claude Enterprise

1. **Org owner:** in the admin settings under Connectors, add a custom connector named "Lawmatics" with the URL `https://<host>/mcp`. Leave the OAuth client ID and secret blank: Claude registers itself. (Menu names may differ in the current Claude UI.)
2. **Each user:** Settings > Connectors > Lawmatics > Connect, then approve access on Lawmatics' screen.

The server accepts Claude's OAuth callbacks (`https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`) by default. If Claude uses a different one, registration fails with `invalid_client_metadata`; add it with `MCP_ALLOWED_REDIRECT_URIS` (keeping the defaults in the list).

## 14. Live test plan

Watch the logs in two terminals on the droplet:

```bash
pm2 logs lawmatics-mcp-lcp
```

```bash
sudo tail -f /var/log/nginx/access.log
```

A successful connection shows, in order: `/.well-known/...`, `POST /register`, `GET /authorize`, `GET /oauth/lawmatics/callback`, `POST /token`, `POST /mcp`.

| # | Test | How | Pass condition |
|---|---|---|---|
| 1 | Admin connects | Connect, then ask Claude "who am I in Lawmatics?" | `get-current-user` returns you, with your name and email |
| 2 | Non-admin connects | A non-admin user connects from their own account | Approval succeeds |
| 3 | Right identity | The non-admin asks "who am I" | Returns them, not you |
| 4 | Attribution | Create a note on a test matter | Lawmatics shows the non-admin as "created by" |
| 5 | Audit log | `tail ~/.lawmatics-mcp/audit.log` | Entries carry the right `user_id` and `user_email` |
| 6 | Upload | Upload a small file to a test matter; Claude asks which folder | The file appears (a local `file_path` is refused in hosted mode; content must be attached) |
| 7 | Stays signed in | Return after more than an hour | Works without signing in again |
| 8 | Restart | `pm2 restart lawmatics-mcp-lcp`, then use Claude | Reconnects without a new Lawmatics sign-in |
| 9 | Offboarding | See "Operations" below, for a test user | Their next request fails; they must connect again |

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `POST /register` returns 400 `invalid_client_metadata` | Claude's callback isn't on the allowlist | The log shows the rejected URI; add it to `MCP_ALLOWED_REDIRECT_URIS` and restart |
| Lawmatics shows a redirect_uri error | The app's Callback URL doesn't match exactly | Fix it in Lawmatics Developer Settings |
| Claude reports access denied right after approving | Email domain allowlist refused the user | Audit log shows `oauth_sign_in` `blocked`; fix `LAWMATICS_ALLOWED_EMAIL_DOMAINS` |
| Repeated 401s, or "Token was not issued for this resource" | `MCP_BASE_URL` doesn't match the public URL | Make it match exactly and restart |
| Sign-in fails with "Lawmatics did not identify the user" | `/users/me` returned an unexpected shape | Capture the log line; the parsing in `src/server/oauth-provider.ts` needs adjusting |
| Responses hang or arrive all at once | Proxy buffering streamed responses | Confirm `proxy_buffering off` |
| Non-admin sees an error on Lawmatics' approval screen | Non-admins can't approve the app on this account | Contact Lawmatics support |
| 429 errors | Firm-wide rate limit (500/min, shared by all integrations and users) | Lower `LAWMATICS_RATE_LIMIT_PER_MIN` to leave headroom, or wait |

## 16. Operations

**Update after a fix:**

```bash
cd /var/www/<host>/lawmatics-mcp-lcp && git pull && npm ci && npm run build && pm2 restart lawmatics-mcp-lcp
```

Users stay connected across restarts: sign-ins are stored in `store.enc`, and open Claude conversations reconnect on their own.

**List connected users / offboard one** (the app must be stopped, or it overwrites the change from memory):

```bash
pm2 stop lawmatics-mcp-lcp
```

```bash
node build/index.js users list
```

```bash
node build/index.js users remove <lawmatics-user-id>
```

```bash
pm2 start lawmatics-mcp-lcp
```

`users remove` deletes the stored token and every token issued to that user, so their Claude access ends immediately. Lawmatics tokens never expire and Lawmatics has no revocation API: also ask support@lawmatics.com to revoke the user's tokens for your app, and deactivate the user in Lawmatics. Each reconnect also mints a new Lawmatics token, and older ones stay valid at Lawmatics until support revokes them.

**Backups:** DigitalOcean Backups cover `~/.lawmatics-mcp/store.enc` and the audit log. The encryption key lives only in `.env` and the password manager; a backup without the key cannot be decrypted.

**Audit log retention:** the audit log records tool arguments, which can include client data. Include it in the firm's retention policy, and consider shipping it off the droplet (for example with Fluent Bit to write-once storage).
