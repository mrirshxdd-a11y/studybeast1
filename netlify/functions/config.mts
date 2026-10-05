import type { Config } from "@netlify/functions";
import { json, loadSettings, sql } from "../lib/core.mts";

// Public, non-sensitive content for the homepage. Never includes member keys.
export default async () => {
  const [settings, platforms] = await Promise.all([
    loadSettings(),
    sql()`SELECT id, name, url FROM platforms WHERE visible = TRUE ORDER BY sort_order, id`,
  ]);
  return json({ settings, platforms });
};

export const config: Config = { path: "/api/config", method: "GET" };
