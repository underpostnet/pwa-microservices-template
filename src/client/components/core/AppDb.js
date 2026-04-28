/**
 * Application database — structured local persistence via **Dexie** (IndexedDB).
 *
 * Dexie is served as a dist library (copied from `node_modules/dexie/dist` to
 * `/dist/dexie/`) and rewritten by the esbuild `importRewritePlugin` at build
 * time, so the `import Dexie from 'dexie'` line below is automatically
 * converted to `import Dexie from '/dist/dexie/dexie.mjs'` in the browser
 * bundle.  No manual URL changes are required.
 *
 * ## Tables
 *
 * | Table     | Schema                      | Purpose                              |
 * |-----------|-----------------------------|--------------------------------------|
 * | `session` | `key, value, expiresAt`     | Auth tokens (JWT) with optional TTL  |
 * | `prefs`   | `key, value`                | User preferences (theme, lang, …)    |
 *
 * ## TTL / expiry
 *
 * `session` entries support an optional `expiresAt` field (unix-ms timestamp).
 * `AppDb.session.get()` silently deletes and returns `undefined` for expired
 * records, providing the same automatic eviction that the previous
 * localStorage stub offered.
 *
 * ## Upgrade path
 *
 * To add a new table or column, increment the version number and add a new
 * `db.version(N).stores(...)` call below.  Dexie handles IndexedDB migrations
 * transparently.
 *
 * ## Usage
 *
 * ```js
 * import { AppDb } from './AppDb.js';
 *
 * // Store a JWT with a TTL derived from the token's refreshExpiresAt claim:
 * await AppDb.session.put({ key: 'jwt', value: token, expiresAt: claims.refreshExpiresAt });
 *
 * // Fast-path read — returns undefined if missing or expired:
 * const stored = await AppDb.session.get('jwt');
 * if (stored) useToken(stored.value);
 *
 * // User preferences:
 * await AppDb.prefs.put({ key: 'theme', value: 'dark' });
 * const { value: theme } = await AppDb.prefs.get('theme') ?? { value: 'light' };
 * ```
 *
 * @module src/client/components/core/AppDb.js
 * @namespace AppDatabase
 */

import Dexie from 'dexie';

// ---------------------------------------------------------------------------
// Database definition
// ---------------------------------------------------------------------------

/**
 * Returns the database name scoped to the current app (PROXY_PATH).
 * e.g. PROXY_PATH '/myapp' → 'appdb-myapp', root → 'appdb-root'.
 *
 * @returns {string}
 * @memberof AppDatabase
 */
const getDbName = () => {
  try {
    const path = window.renderPayload?.PROXY_PATH ?? '/';
    const slug = path.replace(/\//g, '') || 'root';
    return `appdb-${slug}`;
  } catch {
    return 'appdb-root';
  }
};

class AppDatabase extends Dexie {
  /** @type {Dexie.Table<{ key: string; value: any; expiresAt?: number }, string>} */
  session;

  /** @type {Dexie.Table<{ key: string; value: any }, string>} */
  prefs;

  constructor() {
    super(getDbName());

    this.version(1).stores({
      // `key` is the primary key.  `value` and `expiresAt` are indexed so
      // future queries (e.g. bulk-delete expired entries) remain fast.
      session: 'key, value, expiresAt',
      prefs: 'key, value',
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton helpers — thin wrappers that add TTL expiry on reads
// ---------------------------------------------------------------------------

const _db = new AppDatabase();

/**
 * Creates a table accessor that adds automatic TTL expiry on `get` and
 * `toArray`, matching the behaviour of the previous localStorage stub.
 *
 * @template T
 * @param {Dexie.Table<T & { key: string; expiresAt?: number }, string>} table
 * @returns {{ get(key: string): Promise<T|undefined>, put(record: T): Promise<string>, delete(key: string): Promise<void>, clear(): Promise<void>, toArray(): Promise<T[]> }}
 * @memberof AppDatabase
 */
const withTtl = (table) => ({
  /**
   * Retrieves a record by primary key.
   * Returns `undefined` if the key is missing or the record is expired.
   * Expired records are deleted on read.
   *
   * @param {string} key
   * @returns {Promise<T|undefined>}
   */
  async get(key) {
    const record = await table.get(key);
    if (!record) return undefined;
    if (record.expiresAt && record.expiresAt < Date.now()) {
      await table.delete(key);
      return undefined;
    }
    return record;
  },

  /**
   * Inserts or replaces a record (upsert).
   *
   * @param {T & { key: string }} record
   * @returns {Promise<string>} The stored key.
   */
  put: (record) => table.put(record),

  /**
   * Deletes a record by primary key.  No-op if missing.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  delete: (key) => table.delete(key),

  /**
   * Deletes all records in the table.
   *
   * @returns {Promise<void>}
   */
  clear: () => table.clear(),

  /**
   * Returns all non-expired records.
   * Expired records encountered during enumeration are deleted.
   *
   * @returns {Promise<T[]>}
   */
  async toArray() {
    const all = await table.toArray();
    const now = Date.now();
    const expired = all.filter((r) => r.expiresAt && r.expiresAt < now);
    if (expired.length > 0) {
      await table.bulkDelete(expired.map((r) => r.key));
    }
    return all.filter((r) => !r.expiresAt || r.expiresAt >= now);
  },
});

// ---------------------------------------------------------------------------
// Exported singleton
// ---------------------------------------------------------------------------

/**
 * Singleton application database instance.
 *
 * @type {{ session: ReturnType<typeof withTtl>, prefs: ReturnType<typeof withTtl> }}
 * @memberof AppDatabase
 */
export const AppDb = {
  /** Auth tokens with optional expiry. */
  session: withTtl(_db.session),
  /** User preferences (theme, language, last-visited route, …). */
  prefs: withTtl(_db.prefs),
};

export default AppDb;
