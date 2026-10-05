import type { Config, Context } from "@netlify/functions";
import {
  DEVICE_TAKEN_MESSAGE,
  WRONG_KEY_MESSAGE,
  clientIp,
  cookie,
  getCookie,
  json,
  recordAttempt,
  sha256,
  sql,
  tooManyAttempts,
} from "../lib/core.mts";

const DEVICE_COOKIE = "sb_device";
const DEVICE_RE = /^[A-Za-z0-9_-]{20,128}$/;

type KeyRow = { id: number; enabled: boolean; destination_url: string; device_hash: string | null };

export default async (req: Request, context: Context) => {
  const ip = clientIp(req, context);
  if (await tooManyAttempts("member", ip, 10, 15)) {
    return json({ ok: false, error: "Too many attempts. Please wait 15 minutes and try again." }, 429);
  }

  let body: { key?: string; deviceId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: WRONG_KEY_MESSAGE }, 400);
  }

  const key = String(body.key || "").trim().toUpperCase();
  // The HttpOnly cookie is the primary installation identity; the client copy restores it if cookies were cleared.
  const deviceId = getCookie(req, DEVICE_COOKIE) || String(body.deviceId || "");
  if (!DEVICE_RE.test(deviceId)) return json({ ok: false, error: "Could not identify this device. Please reload and try again." }, 400);
  if (!key || key.length > 64) {
    await recordAttempt("member", ip, false);
    return json({ ok: false, error: WRONG_KEY_MESSAGE }, 401);
  }

  const rows = (await sql()`
    SELECT id, enabled, destination_url, device_hash FROM member_keys WHERE access_key = ${key}
  `) as KeyRow[];
  const row = rows[0];
  if (!row) {
    await recordAttempt("member", ip, false);
    return json({ ok: false, error: WRONG_KEY_MESSAGE }, 401);
  }
  if (!row.enabled) {
    await recordAttempt("member", ip, false);
    return json({ ok: false, error: "This key has been disabled. Please contact support." }, 403);
  }

  const deviceHash = sha256(`sb-device:${deviceId}`);
  let boundHash = row.device_hash;
  if (!boundHash) {
    // Atomic first-bind: only one device can win if two log in at the same time.
    const bound = (await sql()`
      UPDATE member_keys SET device_hash = ${deviceHash}, device_bound_at = NOW()
      WHERE id = ${row.id} AND device_hash IS NULL
      RETURNING device_hash
    `) as { device_hash: string }[];
    if (bound[0]) boundHash = bound[0].device_hash;
    else {
      const again = (await sql()`SELECT device_hash FROM member_keys WHERE id = ${row.id}`) as { device_hash: string }[];
      boundHash = again[0]?.device_hash ?? null;
    }
  }

  if (boundHash !== deviceHash) {
    await recordAttempt("member", ip, false);
    return json({ ok: false, error: DEVICE_TAKEN_MESSAGE, code: "DEVICE_TAKEN" }, 403);
  }

  await sql()`UPDATE member_keys SET last_login_at = NOW(), login_count = login_count + 1 WHERE id = ${row.id}`;
  await recordAttempt("member", ip, true);
  return json(
    { ok: true, destination: row.destination_url },
    200,
    { "set-cookie": cookie(DEVICE_COOKIE, deviceId, 400 * 24 * 3600, "/api/login") },
  );
};

export const config: Config = { path: "/api/login", method: "POST" };
