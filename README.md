# AI Video Studio — Render-ready

A polished Node/Express AI video website with accounts, credits, history, text-to-video, image-to-video, and Runway integration.

## What's changed for Render

- Replaced local SQLite with PostgreSQL.
- Added PostgreSQL-backed sessions with `connect-pg-simple`.
- Added automatic database table initialization on startup.
- Added `render.yaml` Blueprint that creates the web service + PostgreSQL database.
- Uses Render's `PORT` and binds to `0.0.0.0`.
- Added `/api/health` for Render health checks.
- Added safer credit charging/refunding transactions.
- Removed the need for a persistent Render disk for application data.
- Keeps the Runway API key server-side.

Render services have an ephemeral filesystem by default, so persistent relational data belongs in Postgres rather than local SQLite. Render recommends managed Postgres for relational data. See the Render docs for details.

## Deploy with Render

### 1. Put this folder in GitHub

Create a GitHub repository and upload the contents of this folder.

Do **not** upload `.env`. The `.gitignore` already excludes it.

### 2. Create the Render Blueprint

In Render, create a new Blueprint and select the GitHub repository containing `render.yaml`.

The Blueprint creates:

- `ai-video-studio` — Node web service
- `ai-video-db` — PostgreSQL database

Render will ask you for the secret `RUNWAYML_API_SECRET` because it is marked `sync: false`.

### 3. Add your Runway API key

Paste your Runway API key into Render's environment variable prompt/dashboard. Never put the key in the frontend or commit it to GitHub.

### 4. Deploy

Render runs:

```bash
npm install
npm start
```

After deployment, open the URL Render gives the service.

## Local development

You need a PostgreSQL database and then:

```bash
npm install
cp .env.example .env
npm start
```

Set `DATABASE_URL` and the other variables in `.env`.

## Runway

The app uses the Runway SDK and the `gen4.5` model by default. It supports text-to-video and image-to-video through the same generation route.

## Important production upgrades before taking payments

This is deployment-ready as an MVP, not a complete commercial platform. Before selling credits publicly, add:

- Payment provider and webhook-based credit purchases
- Email verification and password reset
- Rate limiting and abuse prevention
- Content moderation/usage controls
- Object storage for long-term video files if you need to preserve generated media independently of Runway's output URLs
- Monitoring and error tracking
- Terms of service and privacy policy
- A production-grade background job architecture for high traffic
