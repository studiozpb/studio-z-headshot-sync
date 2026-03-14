# Studio Z Headshot Sync

This is a separate hosted control app for the Dropbox-to-R2 workflow. It does not modify the existing macOS app.

## What it does

- Connects to one Dropbox account via OAuth
- Lets you browse Dropbox folders and select the source folder from the UI
- Stores Cloudflare R2 destination settings
- Runs safe `copy` syncs that upload new and changed files
- Provides destructive `mirror` syncs that also delete files from R2 when they were removed from Dropbox
- Exposes a mobile-friendly web dashboard

## Why this is separate

The current Swift app is a local macOS watcher built around filesystem events. This dashboard is a cloud-hosted alternative where Dropbox is the source of truth and the sync worker runs on the server.

## Current architecture

- Web app and sync worker run in the same Node process
- Dropbox is read via the Dropbox HTTP API
- R2 is written through the S3-compatible API
- App state is persisted in `data/state.json`

This means the easiest first deployment target is a small hosted container service with persistent disk.

## Environment

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

Required values:

- `APP_BASE_URL`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`

Optional defaults:

- `R2_ACCOUNT_ID`
- `R2_BUCKET`
- `R2_PREFIX`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `SMS_RECIPIENTS`

## Dropbox app setup

Create a Dropbox app at [Dropbox App Console](https://www.dropbox.com/developers/apps).

Use:

- Access type: `Full Dropbox`
- Scopes:
  - `account_info.read`
  - `files.metadata.read`
  - `files.content.read`

Add this redirect URI:

```text
https://your-domain.example.com/auth/dropbox/callback
```

Dropbox recommends the OAuth code flow with refresh tokens for server-side apps that need background access. Source: [OAuth Guide](https://developers.dropbox.com/oauth-guide)

## Local run

Install dependencies:

```bash
npm install
```

Start:

```bash
npm run dev
```

Then open:

```text
http://localhost:8787
```

## Deploy as a hosted service

This app is designed to be remotely accessible from phones, tablets, and laptops. The simplest production deployment is a single small container service with HTTPS in front of it.

### Docker image

Build:

```bash
docker build -t studio-z-headshot-sync .
```

Run:

```bash
docker run --rm \
  -p 8787:8787 \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  studio-z-headshot-sync
```

That `data` volume is important because it stores:

- the connected Dropbox refresh token
- the selected Dropbox folder
- the R2 configuration
- the sync manifest and recent run history

### Production notes

- Put this behind HTTPS before using Dropbox OAuth in production
- Set `APP_BASE_URL` to the public URL
- Use a long random `SESSION_SECRET`
- Use a strong `ADMIN_PASSWORD`
- Restrict access at the hosting layer too if you want a second gate

## GitHub deploy on Railway

This is the recommended path for `sync.studiozphotobooths.com`.

### 1. Put this app in its own GitHub repo

Use the `studio-z-headshot-sync` folder as the repository root. Do not deploy the larger parent directory as-is.

The folder already includes:

- `Dockerfile`
- `railway.toml`
- `.gitignore`

### 2. Deploy from GitHub in Railway

Railway’s GitHub flow is:

1. Create a new project
2. Choose `Deploy from GitHub repo`
3. Select the repository
4. Railway will build from the Dockerfile

Railway also supports automatic redeploys from the selected GitHub branch. Sources: [Railway GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys), [Railway public domains](https://docs.railway.com/reference/public-domains)

### 3. Add a volume

Create a persistent volume and mount it to:

```text
/app/data
```

That keeps:

- Dropbox refresh tokens
- selected folder settings
- R2 settings
- sync manifest and recent history

### 4. Add environment variables

At minimum:

- `PORT=8787`
- `APP_BASE_URL=https://sync.studiozphotobooths.com`
- `ADMIN_PASSWORD=...`
- `SESSION_SECRET=...`
- `DROPBOX_APP_KEY=...`
- `DROPBOX_APP_SECRET=...`

Optional defaults:

- `R2_ACCOUNT_ID=...`
- `R2_BUCKET=...`
- `R2_PREFIX=...`
- `R2_ACCESS_KEY_ID=...`
- `R2_SECRET_ACCESS_KEY=...`
- `TWILIO_ACCOUNT_SID=...`
- `TWILIO_AUTH_TOKEN=...`
- `TWILIO_FROM_NUMBER=+15551234567`
- `SMS_RECIPIENTS=+15551234567,+15557654321`

### 5. Add the Railway custom domain

In Railway:

1. Open the deployed service
2. Go to `Settings`
3. Open `Networking`
4. Add custom domain `sync.studiozphotobooths.com`

Railway will give you the DNS target to add.

### 6. Add the DNS record in Squarespace

In Squarespace DNS settings, add the record Railway tells you to use for the subdomain.

For subdomains, this is usually a `CNAME` record for:

```text
sync.studiozphotobooths.com
```

pointing to the Railway-provided hostname.

Squarespace’s DNS docs cover adding custom records for subdomains. Source: [Squarespace DNS settings](https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-custom-DNS-records-to-your-Squarespace-managed-domain)

### 7. Update Dropbox OAuth

In the Dropbox app console, add:

```text
https://sync.studiozphotobooths.com/auth/dropbox/callback
```

as an allowed redirect URI.

## Safe operating model

- Use `automatic copy` during normal operation
- Use `preview mirror` before any destructive sync
- Use `apply mirror` only when Dropbox deletions should propagate to R2
- Use the `SMS notifications` panel if you want Twilio texts on upload success or sync failures

The app requires typing today’s UTC date before a destructive mirror is allowed.

## Storage notes

- Credentials and selection state are persisted in `data/state.json`
- The sync manifest is also stored there so unchanged files do not need to re-upload every run
- If the state file is deleted, the next run will re-scan and may re-upload files

## Limitations in this first version

- Single admin password
- Single connected Dropbox account
- Single selected source folder at a time
- Single R2 destination at a time
- No per-user roles or audit trail beyond recent run history

## Suggested next steps

- Deploy behind HTTPS on a small cloud VM or container host
- Put the site behind an additional auth layer if you want stronger access control
- Add alerts for failed runs
- Add object versioning in R2 if you want safer destructive mirrors
