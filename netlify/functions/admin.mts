import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  ADMIN_COOKIE,
  SETTING_SECTIONS,
  clientIp,
  cookie,
  createAdminSession,
  destroyAdminSession,
  hashPassword,
  isAdmin,
  isHttpUrl,
  json,
  loadSettings,
  normalizePhone,
  randomToken,
  recordAttempt,
  sanitizeSection,
  sha256,
  sql,
  tooManyAttempts,
  verifyPassword,
} from "../lib/core.mts";

const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_UPLOAD = { image: 8 * 1024 * 1024, video: 300 * 1024 * 1024 };
const GENERIC_LOGIN_ERROR = "Incorrect phone number or password.";

type Admin = { phone: string; password_hash: string };
type Handler = (req: Request, ctx: Context, args: string[]) => Promise<Response>;

async function getAdminAccount() {
  const rows = (await sql()`SELECT phone, password_hash FROM admin_account WHERE id = 1`) as Admin[];
  return rows[0];
}

async function readJson(req: Request) {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

function validPassword(password: string) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long.";
  return null;
}

/* ---------------- SMS OTP (Twilio Verify) ---------------- */

function twilioConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid || !token || !service) return null;
  return { auth: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), service };
}

const e164 = (phone: string) => `${process.env.ADMIN_PHONE_COUNTRY_CODE || "+91"}${phone}`;

async function twilio(path: string, form: Record<string, string>) {
  const cfg = twilioConfig()!;
  const res = await fetch(`https://verify.twilio.com/v2/Services/${cfg.service}/${path}`, {
    method: "POST",
    headers: { authorization: cfg.auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { ok: res.ok, status: res.status, data };
}

const SMS_NOT_CONFIGURED =
  "SMS OTP service is not configured on the server yet. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID in Netlify environment variables.";

/* ---------------- Public auth routes ---------------- */

const authLogin: Handler = async (req, ctx) => {
  const ip = clientIp(req, ctx);
  if (await tooManyAttempts("admin", ip, 5, 15)) {
    return json({ error: "Too many failed attempts. Please wait 15 minutes." }, 429);
  }
  const body = await readJson(req);
  const phone = normalizePhone(body.phone);
  const password = String(body.password || "");
  const admin = await getAdminAccount();
  const ok = !!admin && phone === admin.phone && password.length > 0 && (await verifyPassword(password, admin.password_hash));
  await recordAttempt("admin", ip, ok);
  if (!ok) return json({ error: GENERIC_LOGIN_ERROR }, 401);
  return json({ ok: true }, 200, { "set-cookie": await createAdminSession() });
};

const authLogout: Handler = async (req) => json({ ok: true }, 200, { "set-cookie": await destroyAdminSession(req) });

const authMe: Handler = async (req) => json({ authenticated: await isAdmin(req), smsConfigured: !!twilioConfig() });

const forgotStart: Handler = async (req, ctx) => {
  const ip = clientIp(req, ctx);
  if (await tooManyAttempts("otp-send", ip, 4, 30)) return json({ error: "Too many OTP requests. Please wait 30 minutes." }, 429);
  const phone = normalizePhone((await readJson(req)).phone);
  const admin = await getAdminAccount();
  if (!admin || phone !== admin.phone) {
    await recordAttempt("otp-send", ip, false);
    return json({ error: "This phone number is not registered as the admin number." }, 400);
  }
  if (!twilioConfig()) return json({ error: SMS_NOT_CONFIGURED, code: "SMS_NOT_CONFIGURED" }, 503);
  const res = await twilio("Verifications", { To: e164(phone), Channel: "sms" });
  // Count every send toward the limit so SMS cannot be spammed.
  await recordAttempt("otp-send", ip, false);
  if (!res.ok) {
    console.error("Twilio send failed", res.status, res.data?.code);
    return json({ error: "Could not send the OTP right now. Please try again shortly." }, 502);
  }
  return json({ ok: true, sentTo: `******${phone.slice(-4)}` });
};

const forgotVerify: Handler = async (req, ctx) => {
  const ip = clientIp(req, ctx);
  if (await tooManyAttempts("otp-verify", ip, 6, 30)) return json({ error: "Too many wrong codes. Please wait 30 minutes." }, 429);
  const body = await readJson(req);
  const phone = normalizePhone(body.phone);
  const code = String(body.code || "").replace(/\D/g, "");
  const admin = await getAdminAccount();
  if (!admin || phone !== admin.phone || code.length < 4 || code.length > 10) {
    await recordAttempt("otp-verify", ip, false);
    return json({ error: "Invalid OTP." }, 400);
  }
  if (!twilioConfig()) return json({ error: SMS_NOT_CONFIGURED, code: "SMS_NOT_CONFIGURED" }, 503);
  const res = await twilio("VerificationCheck", { To: e164(phone), Code: code });
  if (!res.ok || res.data?.status !== "approved") {
    await recordAttempt("otp-verify", ip, false);
    return json({ error: "Invalid or expired OTP." }, 400);
  }
  await recordAttempt("otp-verify", ip, true);
  const resetToken = randomToken();
  await sql()`
    INSERT INTO password_resets (token_hash, expires_at)
    VALUES (${sha256(resetToken)}, NOW() + INTERVAL '10 minutes')
  `;
  return json({ ok: true, resetToken });
};

const forgotReset: Handler = async (req) => {
  const body = await readJson(req);
  const password = String(body.password || "");
  const problem = validPassword(password);
  if (problem) return json({ error: problem }, 400);
  if (password !== String(body.confirm || "")) return json({ error: "Passwords do not match." }, 400);
  const used = (await sql()`
    UPDATE password_resets SET used = TRUE
    WHERE token_hash = ${sha256(String(body.resetToken || ""))} AND used = FALSE AND expires_at > NOW()
    RETURNING token_hash
  `) as unknown[];
  if (!used.length) return json({ error: "This reset session has expired. Please request a new OTP." }, 400);
  await sql()`UPDATE admin_account SET password_hash = ${await hashPassword(password)}, password_updated_at = NOW() WHERE id = 1`;
  // Old password and every existing session stop working immediately.
  await sql()`DELETE FROM admin_sessions`;
  await sql()`DELETE FROM password_resets WHERE expires_at < NOW() OR used = TRUE`;
  return json({ ok: true });
};

/* ---------------- Protected routes ---------------- */

const changePassword: Handler = async (req) => {
  const body = await readJson(req);
  const admin = await getAdminAccount();
  if (!(await verifyPassword(String(body.current || ""), admin.password_hash))) {
    return json({ error: "Current password is incorrect." }, 400);
  }
  const password = String(body.password || "");
  const problem = validPassword(password);
  if (problem) return json({ error: problem }, 400);
  if (password !== String(body.confirm || "")) return json({ error: "Passwords do not match." }, 400);
  await sql()`UPDATE admin_account SET password_hash = ${await hashPassword(password)}, password_updated_at = NOW() WHERE id = 1`;
  await sql()`DELETE FROM admin_sessions`;
  return json({ ok: true }, 200, { "set-cookie": await createAdminSession() });
};

const getData: Handler = async () => {
  const [settings, keys, platforms] = await Promise.all([
    loadSettings(),
    sql()`
      SELECT id, access_key, label, destination_url, enabled, device_hash IS NOT NULL AS device_bound,
             device_bound_at, last_login_at, login_count, created_at
      FROM member_keys ORDER BY id`,
    sql()`SELECT id, name, url, visible, sort_order FROM platforms ORDER BY sort_order, id`,
  ]);
  return json({ settings, keys, platforms });
};

const saveSettings: Handler = async (req, _ctx, [section]) => {
  if (!SETTING_SECTIONS.includes(section)) return json({ error: "Unknown section." }, 404);
  const clean = sanitizeSection(section, await readJson(req));
  if (!clean) return json({ error: "Invalid data." }, 400);
  for (const field of ["url", "screenshotUrl"]) {
    if (clean[field] && !isHttpUrl(String(clean[field]))) return json({ error: `"${field}" must be a valid http(s) link.` }, 400);
  }
  for (const field of ["logoUrl", "qrUrl", "videoUrl"]) {
    const v = String(clean[field] ?? "");
    if (v && !(isHttpUrl(v) || /^\/(?!\/)[\w\-./]+$/.test(v))) return json({ error: `"${field}" is not a valid file link.` }, 400);
  }
  if (clean.accent && !/^#[0-9a-f]{6}$/i.test(String(clean.accent))) return json({ error: "Accent must be a hex colour like #f5b82e." }, 400);
  const current = (await loadSettings())[section];
  const merged = { ...current, ...clean };
  await sql()`
    INSERT INTO settings (section, value, updated_at) VALUES (${section}, ${JSON.stringify(merged)}::jsonb, NOW())
    ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  // Clean up media that was replaced or removed.
  for (const [k, v] of Object.entries(current)) {
    if (typeof v === "string" && v.startsWith("/api/media/") && merged[k] !== v) await deleteMedia(v.split("/").pop()!);
  }
  return json({ ok: true, value: merged });
};

function keyInput(body: Record<string, any>) {
  const access_key = String(body.access_key || "").trim().toUpperCase();
  const destination_url = String(body.destination_url || "").trim();
  if (!/^[A-Z0-9-]{4,64}$/.test(access_key)) return { error: "Key must be 4–64 characters: letters, numbers and dashes." };
  if (!isHttpUrl(destination_url)) return { error: "Destination must be a valid http(s) link." };
  return { access_key, destination_url, label: String(body.label || "").slice(0, 120), enabled: body.enabled !== false };
}

const createKey: Handler = async (req) => {
  const v = keyInput(await readJson(req));
  if ("error" in v) return json(v, 400);
  try {
    await sql()`INSERT INTO member_keys (access_key, label, destination_url, enabled)
      VALUES (${v.access_key}, ${v.label}, ${v.destination_url}, ${v.enabled})`;
  } catch {
    return json({ error: "That key already exists." }, 409);
  }
  return json({ ok: true }, 201);
};

const updateKey: Handler = async (req, _ctx, [id]) => {
  const v = keyInput(await readJson(req));
  if ("error" in v) return json(v, 400);
  try {
    // Changing the key text releases the device binding, since it is effectively a new key.
    await sql()`
      UPDATE member_keys SET
        device_hash = CASE WHEN access_key = ${v.access_key} THEN device_hash ELSE NULL END,
        device_bound_at = CASE WHEN access_key = ${v.access_key} THEN device_bound_at ELSE NULL END,
        access_key = ${v.access_key}, label = ${v.label}, destination_url = ${v.destination_url}, enabled = ${v.enabled}
      WHERE id = ${Number(id)}`;
  } catch {
    return json({ error: "That key already exists." }, 409);
  }
  return json({ ok: true });
};

const deleteKey: Handler = async (_req, _ctx, [id]) => {
  await sql()`DELETE FROM member_keys WHERE id = ${Number(id)}`;
  return json({ ok: true });
};

const resetDevice: Handler = async (_req, _ctx, [id]) => {
  await sql()`UPDATE member_keys SET device_hash = NULL, device_bound_at = NULL WHERE id = ${Number(id)}`;
  return json({ ok: true });
};

function platformInput(body: Record<string, any>) {
  const name = String(body.name || "").trim().slice(0, 80);
  const url = String(body.url || "").trim();
  if (!name) return { error: "Platform name is required." };
  if (url && !isHttpUrl(url)) return { error: "URL must be a valid http(s) link (or left empty)." };
  return { name, url, visible: body.visible !== false };
}

const createPlatform: Handler = async (req) => {
  const v = platformInput(await readJson(req));
  if ("error" in v) return json(v, 400);
  await sql()`INSERT INTO platforms (name, url, visible, sort_order)
    VALUES (${v.name}, ${v.url}, ${v.visible}, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM platforms))`;
  return json({ ok: true }, 201);
};

const updatePlatform: Handler = async (req, _ctx, [id]) => {
  const v = platformInput(await readJson(req));
  if ("error" in v) return json(v, 400);
  await sql()`UPDATE platforms SET name = ${v.name}, url = ${v.url}, visible = ${v.visible} WHERE id = ${Number(id)}`;
  return json({ ok: true });
};

const deletePlatform: Handler = async (_req, _ctx, [id]) => {
  await sql()`DELETE FROM platforms WHERE id = ${Number(id)}`;
  return json({ ok: true });
};

const reorderPlatforms: Handler = async (req) => {
  const ids = (await readJson(req)).ids;
  if (!Array.isArray(ids)) return json({ error: "Invalid order." }, 400);
  for (let i = 0; i < ids.length; i++) {
    await sql()`UPDATE platforms SET sort_order = ${i + 1} WHERE id = ${Number(ids[i])}`;
  }
  return json({ ok: true });
};

/* ---------------- Chunked media uploads ---------------- */

type Manifest = { type: string; size: number; chunkSize: number; chunks: number; pending?: boolean };

async function deleteMedia(id: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return;
  const store = getStore("media");
  const manifest = (await store.get(`m/${id}`, { type: "json" })) as Manifest | null;
  if (!manifest) return;
  for (let n = 0; n < manifest.chunks; n++) await store.delete(`c/${id}/${n}`);
  await store.delete(`m/${id}`);
}

const uploadInit: Handler = async (req) => {
  const body = await readJson(req);
  const type = String(body.type || "");
  const size = Number(body.size || 0);
  const kind = type.startsWith("video/") ? "video" : type.startsWith("image/") ? "image" : null;
  if (!kind || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(type)) return json({ error: "Only image or video files are allowed." }, 400);
  if (!size || size > MAX_UPLOAD[kind]) {
    return json({ error: `File is too large (max ${MAX_UPLOAD[kind] / 1024 / 1024} MB).` }, 400);
  }
  const id = randomToken(12);
  const manifest: Manifest = { type, size, chunkSize: CHUNK_SIZE, chunks: Math.ceil(size / CHUNK_SIZE), pending: true };
  await getStore("media").setJSON(`p/${id}`, manifest);
  return json({ id, chunkSize: CHUNK_SIZE, chunks: manifest.chunks });
};

const uploadChunk: Handler = async (req, _ctx, [id, n]) => {
  const store = getStore("media");
  const manifest = (await store.get(`p/${id}`, { type: "json" })) as Manifest | null;
  const index = Number(n);
  if (!manifest || !Number.isInteger(index) || index < 0 || index >= manifest.chunks) return json({ error: "Invalid upload." }, 400);
  const data = await req.arrayBuffer();
  const expected = index === manifest.chunks - 1 ? manifest.size - index * CHUNK_SIZE : CHUNK_SIZE;
  if (data.byteLength !== expected) return json({ error: "Chunk size mismatch." }, 400);
  await store.set(`c/${id}/${index}`, data);
  return json({ ok: true });
};

const uploadComplete: Handler = async (_req, _ctx, [id]) => {
  const store = getStore("media");
  const manifest = (await store.get(`p/${id}`, { type: "json" })) as Manifest | null;
  if (!manifest) return json({ error: "Invalid upload." }, 400);
  const { blobs } = await store.list({ prefix: `c/${id}/` });
  if (blobs.length !== manifest.chunks) return json({ error: "Upload incomplete. Please retry." }, 400);
  delete manifest.pending;
  await store.setJSON(`m/${id}`, manifest);
  await store.delete(`p/${id}`);
  return json({ ok: true, url: `/api/media/${id}`, type: manifest.type });
};

/* ---------------- Router ---------------- */

const publicRoutes: Record<string, Handler> = {
  "POST auth/login": authLogin,
  "POST auth/logout": authLogout,
  "GET auth/me": authMe,
  "POST auth/forgot/start": forgotStart,
  "POST auth/forgot/verify": forgotVerify,
  "POST auth/forgot/reset": forgotReset,
};

const protectedRoutes: [string, RegExp, Handler][] = [
  ["POST", /^auth\/change-password$/, changePassword],
  ["GET", /^data$/, getData],
  ["PUT", /^settings\/([a-z]+)$/, saveSettings],
  ["POST", /^keys$/, createKey],
  ["PUT", /^keys\/(\d+)$/, updateKey],
  ["DELETE", /^keys\/(\d+)$/, deleteKey],
  ["POST", /^keys\/(\d+)\/reset-device$/, resetDevice],
  ["POST", /^platforms$/, createPlatform],
  ["PUT", /^platforms\/(\d+)$/, updatePlatform],
  ["DELETE", /^platforms\/(\d+)$/, deletePlatform],
  ["POST", /^platforms\/reorder$/, reorderPlatforms],
  ["POST", /^uploads$/, uploadInit],
  ["PUT", /^uploads\/([A-Za-z0-9_-]+)\/(\d+)$/, uploadChunk],
  ["POST", /^uploads\/([A-Za-z0-9_-]+)\/complete$/, uploadComplete],
];

export default async (req: Request, ctx: Context) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/admin\/?/, "").replace(/\/$/, "");
  // CSRF guard: browsers cannot send this custom header cross-site without a CORS preflight, which we never allow.
  if (req.method !== "GET" && req.headers.get("x-sb-admin") !== "1") return json({ error: "Forbidden." }, 403);
  try {
    const pub = publicRoutes[`${req.method} ${path}`];
    if (pub) return await pub(req, ctx, []);
    for (const [method, re, handler] of protectedRoutes) {
      const m = method === req.method ? re.exec(path) : null;
      if (!m) continue;
      if (!(await isAdmin(req))) return json({ error: "Session expired. Please log in again." }, 401, { "set-cookie": cookie(ADMIN_COOKIE, "", 0) });
      return await handler(req, ctx, m.slice(1));
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("Admin API error", (err as Error).message);
    return json({ error: "Server error. Please try again." }, 500);
  }
};

export const config: Config = { path: "/api/admin/*" };
