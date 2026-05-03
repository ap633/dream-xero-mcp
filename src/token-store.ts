// Persistent token store for OAuth refresh tokens.
//
// Default behaviour: if DATABASE_URL is set, persist to Postgres so that
// Railway redeploys don't lose authorisations. If DATABASE_URL is not set,
// silently fall back to in-memory only (the original v2.0.0 behaviour) —
// useful for local dev and as a safety net.
//
// Schema:
//   CREATE TABLE oauth_tokens (
//     id           TEXT PRIMARY KEY,           -- always 'default' (single-user model)
//     access_token TEXT NOT NULL,
//     refresh_token TEXT NOT NULL,
//     expires_at   BIGINT NOT NULL,            -- unix ms
//     updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
//   );
//
// We only ever store ONE row (id='default') because this MCP is built around
// a single advisor login authorising many tenants. If we later want multi-user
// support, we'd partition by user/session.

import { Pool } from "pg";

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const ROW_ID = "default";

let pool: Pool | null = null;
let initialised = false;
let initPromise: Promise<void> | null = null;

export function isPersistentStoreEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

async function ensureInitialised(): Promise<void> {
  if (initialised || !isPersistentStoreEnabled()) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Railway managed Postgres uses TLS; relax verify so the standard
      // connection string just works without manual cert config.
      ssl: process.env.DATABASE_SSL_DISABLED === "true"
        ? false
        : { rejectUnauthorized: false },
      max: 3,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id            TEXT PRIMARY KEY,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    BIGINT NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    initialised = true;
    console.log("✅ Persistent token store ready (Postgres)");
  })();
  return initPromise;
}

export async function loadStoredToken(): Promise<StoredToken | null> {
  if (!isPersistentStoreEnabled()) return null;
  try {
    await ensureInitialised();
    if (!pool) return null;
    const result = await pool.query<{
      access_token: string;
      refresh_token: string;
      expires_at: string; // BIGINT comes back as string in pg
    }>(
      "SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE id = $1 LIMIT 1",
      [ROW_ID]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: parseInt(row.expires_at, 10),
    };
  } catch (err) {
    console.error("loadStoredToken error:", err);
    return null;
  }
}

export async function saveStoredToken(t: StoredToken): Promise<void> {
  if (!isPersistentStoreEnabled()) return;
  try {
    await ensureInitialised();
    if (!pool) return;
    await pool.query(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE
         SET access_token = EXCLUDED.access_token,
             refresh_token = EXCLUDED.refresh_token,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [ROW_ID, t.accessToken, t.refreshToken, t.expiresAt]
    );
  } catch (err) {
    console.error("saveStoredToken error:", err);
    // Don't throw — token is still in memory, the call that produced it
    // succeeded. We just lose persistence for this update.
  }
}

export async function clearStoredToken(): Promise<void> {
  if (!isPersistentStoreEnabled()) return;
  try {
    await ensureInitialised();
    if (!pool) return;
    await pool.query("DELETE FROM oauth_tokens WHERE id = $1", [ROW_ID]);
  } catch (err) {
    console.error("clearStoredToken error:", err);
  }
}
