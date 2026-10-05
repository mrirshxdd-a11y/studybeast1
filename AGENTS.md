# AGENTS.md — STUDY BEAST

## Architecture
- `public/` is published as-is (no bundler). `index.html` + `assets/app.js|app.css` is the homepage; `sb-admin/index.html` + `assets/admin.js|admin.css` is the hidden admin panel. There is intentionally no link to the admin panel from the homepage.
- `netlify/functions/` — `config.mts` (GET `/api/config`, public content only), `login.mts` (POST `/api/login`, key validation + one-device binding), `media.mts` (GET `/api/media/:id`, chunked blob streaming with Range), `admin.mts` (everything under `/api/admin/*`, small internal router).
- `netlify/lib/core.mts` — DB access, settings defaults (`DEFAULT_SETTINGS`), scrypt password hashing, admin sessions, rate limiting.
- `netlify/database/migrations/` — hand-written SQL (native `@netlify/database` driver, no Drizzle). Never edit an applied migration; add a new one.
- `android-icon/` — adaptive launcher icon resources for the separate APK project.

## Conventions / non-obvious decisions
- Settings are stored per section as JSONB; code defaults are merged with DB values, so adding a new field only needs a default in `DEFAULT_SETTINGS` (`sanitizeSection` only accepts keys present there, typed like the default).
- Device binding: the client generates an installation id (localStorage) mirrored into an HttpOnly cookie; the server stores only its SHA-256 and binds atomically on first login. Admin "Reset device" clears it.
- Admin auth: password only stored as scrypt hash; sessions are random tokens (hashed in DB) in an HttpOnly SameSite=Strict cookie. Mutating admin requests must send `x-sb-admin: 1` (CSRF guard). Password reset/change deletes all sessions.
- Forgot password uses Twilio Verify (server-side OTP check), then a 10-minute single-use reset token.
- Uploads are split client-side into 4 MB chunks (function payload limit) and stored as `c/<id>/<n>` with a manifest `m/<id>`.
- All public rendering uses `textContent`/DOM APIs — never inject settings as HTML.
- Service worker is network-first and skips `/api/` and `/sb-admin`; bump `VERSION` in `public/sw.js` if caching behaviour changes.
