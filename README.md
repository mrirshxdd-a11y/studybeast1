# STUDY BEAST — by Mr Irshad

Member-access website for STUDY BEAST with a hidden admin panel.

- **Public site (`/`)** — splash screen, centered branding, top-right Contact, one Member Login card (key login, save key, Login Demo, Get Key / payment QR), Available Platforms, Books, Telegram, footer.
- **Admin panel (`/sb-admin`)** — phone + password login, SMS-OTP password reset, and a dashboard that edits every public section live.

## Technology

- Static HTML/CSS/vanilla JS in `public/` (no frontend build step)
- Netlify Functions (`netlify/functions/*.mts`) for all server logic
- Netlify Database (Postgres) for keys, device bindings, platforms, settings, admin account and sessions — schema in `netlify/database/migrations/`
- Netlify Blobs (`media` store) for uploaded logo / QR / demo video, served with HTTP Range support from `/api/media/:id`
- Twilio Verify for the admin Forgot-Password SMS OTP

## Run locally

```bash
npm install
netlify dev
```

## Required production configuration

Forgot Password sends a real SMS OTP through Twilio Verify. Set these environment variables in Netlify (Project configuration → Environment variables) and redeploy:

| Variable | Value |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_VERIFY_SERVICE_SID` | SID of a Twilio Verify service (starts with `VA`) |
| `ADMIN_PHONE_COUNTRY_CODE` | Optional, defaults to `+91` |

Until they are set, the reset screen clearly says SMS is not configured; it never fakes an OTP.

## Android APK icon

`android-icon/res/` contains a ready adaptive launcher icon (dark `#0B0B0C` background layer + logo foreground inside the 66dp safe zone, legacy and round PNGs for all densities). Copy the `res/` folders into the APK project's `app/src/main/res/`, rebuild and reinstall the APK. A website deploy does not change an installed APK's icon.
