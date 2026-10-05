import { getDatabase } from "@netlify/database";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

let database: ReturnType<typeof getDatabase> | null = null;
export const sql = () => (database ??= getDatabase()).sql;

export const WRONG_KEY_MESSAGE = "Wrong key. Please make the payment and receive your key, then login.";
export const DEVICE_TAKEN_MESSAGE = "This key is already linked to another device.";

/* ---------------- Public content defaults (overridden by the settings table) ---------------- */

export const DEFAULT_SETTINGS: Record<string, Record<string, unknown>> = {
  brand: {
    appName: "STUDY BEAST",
    subtitle: "by Mr Irshad",
    logoUrl: "/img/logo-480.webp",
    accent: "#f5b82e",
  },
  contact: {
    text: "Contact",
    url: "https://t.me/MrIrshxd",
  },
  login: {
    heading: "MEMBER LOGIN",
    tagline: "Unlock your premium content",
  },
  demo: {
    title: "LOGIN DEMO",
    description: "Watch how to log in with your member key.",
    videoUrl: "",
    videoType: "",
  },
  payment: {
    buttonLabel: "GET KEY",
    heading: "GET LIFETIME ACCESS",
    price: "₹199",
    priceNote: "one-time",
    description: "Scan the QR code and complete the payment.",
    qrUrl: "/img/payment-qr.jpg",
    benefits: ["Lifetime Access", "Secure Login", "Premium Learning Content", "Access after payment verification"],
    screenshotLabel: "SEND PAYMENT SCREENSHOT →",
    screenshotUrl: "https://t.me/MrIrshxd",
  },
  platforms: {
    heading: "AVAILABLE PLATFORMS",
  },
  books: {
    title: "📚 BOOKS",
    description: "Premium Books & Study Resources",
    buttonLabel: "GET PREMIUM BOOKS →",
    url: "https://subtle-malabi-35b553.netlify.app/",
  },
  telegram: {
    heading: "JOIN OUR TELEGRAM CHANNEL",
    buttonLabel: "JOIN CHANNEL →",
    url: "https://t.me/StudyBeast1",
  },
  general: {
    siteTitle: "STUDY BEAST — by Mr Irshad",
    metaDescription: "STUDY BEAST by Mr Irshad — premium member access to learning content.",
    footerNote: "",
    splashEnabled: true,
  },
};

export const SETTING_SECTIONS = Object.keys(DEFAULT_SETTINGS);

export async function loadSettings() {
  const rows = (await sql()`SELECT section, value FROM settings`) as { section: string; value: Record<string, unknown> }[];
  const out: Record<string, Record<string, unknown>> = {};
  for (const section of SETTING_SECTIONS) out[section] = { ...DEFAULT_SETTINGS[section] };
  for (const row of rows) {
    if (out[row.section]) out[row.section] = { ...out[row.section], ...row.value };
  }
  return out;
}

/* Only accept known keys with the same primitive type as the default. */
export function sanitizeSection(section: string, input: unknown) {
  const defaults = DEFAULT_SETTINGS[section];
  if (!defaults || typeof input !== "object" || input === null) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (Array.isArray(def)) {
      if (Array.isArray(value)) clean[key] = value.map((v) => String(v).slice(0, 300)).filter(Boolean).slice(0, 30);
    } else if (typeof def === "boolean") {
      clean[key] = Boolean(value);
    } else {
      clean[key] = String(value ?? "").slice(0, 2000);
    }
  }
  return clean;
}

/* ---------------- Helpers ---------------- */

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function getCookie(req: Request, name: string) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, path = "/") {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clientIp(req: Request, context: { ip?: string }) {
  return context.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";
}

export function isHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/* ---------------- Passwords ---------------- */

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ---------------- Rate limiting ---------------- */

export async function tooManyAttempts(scope: string, ip: string, maxFailures: number, windowMinutes: number) {
  const rows = (await sql()`
    SELECT COUNT(*)::int AS n FROM auth_attempts
    WHERE scope = ${scope} AND ip = ${ip} AND success = FALSE
      AND created_at > NOW() - make_interval(mins => ${windowMinutes}::int)
  `) as { n: number }[];
  return (rows[0]?.n ?? 0) >= maxFailures;
}

export async function recordAttempt(scope: string, ip: string, success: boolean) {
  await sql()`INSERT INTO auth_attempts (scope, ip, success) VALUES (${scope}, ${ip}, ${success})`;
  // Keep the table small.
  await sql()`DELETE FROM auth_attempts WHERE created_at < NOW() - INTERVAL '2 days'`;
}

/* ---------------- Admin sessions ---------------- */

export const ADMIN_COOKIE = "sb_admin";
const SESSION_HOURS = 12;

export async function createAdminSession() {
  const token = randomToken();
  await sql()`
    INSERT INTO admin_sessions (token_hash, expires_at)
    VALUES (${sha256(token)}, NOW() + make_interval(hours => ${SESSION_HOURS}::int))
  `;
  await sql()`DELETE FROM admin_sessions WHERE expires_at < NOW()`;
  return cookie(ADMIN_COOKIE, token, SESSION_HOURS * 3600);
}

export async function isAdmin(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE);
  if (!token) return false;
  const rows = (await sql()`
    SELECT 1 FROM admin_sessions WHERE token_hash = ${sha256(token)} AND expires_at > NOW()
  `) as unknown[];
  return rows.length > 0;
}

export async function destroyAdminSession(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE);
  if (token) await sql()`DELETE FROM admin_sessions WHERE token_hash = ${sha256(token)}`;
  return cookie(ADMIN_COOKIE, "", 0);
}

/* Normalises Indian mobile numbers to the 10-digit local form. */
export function normalizePhone(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}
