/**
 * Configurable Progressive Web App (PWA) service worker.
 *
 * Caching strategy overview:
 *   - install  : precache each asset individually so one 404 cannot abort the
 *                entire install; assets that fail are skipped and logged.
 *   - activate : delete every cache whose name is not in the current allow-list
 *                (prevents stale caches accumulating across deployments), then
 *                claim all open clients immediately.
 *   - fetch    : network-first with offline / maintenance fallback pages.
 *
 * Configuration is injected by the build pipeline as a prepended script:
 *   self.renderPayload = JSON.parse(`{...}`);
 *
 * @module src/client/sw/default.sw.js
 * @namespace PwaServiceWorker
 */

/** @type {string[]} Static resources to precache during install. */
const PRE_CACHED_RESOURCES = self.renderPayload?.PRE_CACHED_RESOURCES ?? [];

/**
 * Versioned cache name.  Changing this value (e.g. via renderPayload at
 * build time) automatically invalidates all previous caches in the activate
 * handler below.
 * @type {string}
 */
const CACHE_NAME = self.renderPayload?.CACHE_NAME ?? 'app-cache-v1';

/** @type {string} The proxy / sub-directory path this app is mounted under. */
const PROXY_PATH = self.renderPayload?.PROXY_PATH ?? '/';

/** @type {string[]} All cache names that are valid for the current SW version. */
const CURRENT_CACHES = [CACHE_NAME];

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  // Activate immediately — do not wait for existing tabs to close.
  self.skipWaiting();

  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Precache resources one-by-one so that a single 404 does not abort
      // the entire install (unlike cache.addAll which is all-or-nothing).
      for (const resource of PRE_CACHED_RESOURCES) {
        try {
          await cache.add(resource);
        } catch (error) {
          console.error('[SW] precache miss — skipping', resource, error);
        }
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Enable navigation preload when supported (reduces navigation latency).
      // https://developers.google.com/web/updates/2017/02/navigation-preload
      if ('navigationPreload' in self.registration) {
        await self.registration.navigationPreload.enable();
      }

      // Delete any cache whose name is no longer current.  This prevents
      // stale assets from persisting across deployments.
      const existingCacheNames = await caches.keys();
      await Promise.all(
        existingCacheNames
          .filter((name) => !CURRENT_CACHES.includes(name))
          .map((name) => {
            console.info('[SW] deleting stale cache', name);
            return caches.delete(name);
          }),
      );
    })(),
  );

  // Take control of all open clients without waiting for a page reload.
  self.clients.claim();
});

// ---------------------------------------------------------------------------
// message — supports skipWaiting command from the main thread
// ---------------------------------------------------------------------------

self.addEventListener('message', (event) => {
  if (event.data?.status === 'skipWaiting') self.skipWaiting();
});

// ---------------------------------------------------------------------------
// fetch — network-first with layered cache fallback
// ---------------------------------------------------------------------------

/**
 * Returns the normalized path prefix for offline/maintenance page URLs.
 * @returns {string}
 */
const proxyPrefix = () => (PROXY_PATH === '/' ? '' : PROXY_PATH);

/**
 * Attempts to retrieve a response from any open cache.
 * Checks the specific CACHE_NAME first, then falls back to `caches.match`.
 * @param {Request} request - The original fetch request.
 * @param {string} [matchPath] - Explicit cache key to try first.
 * @returns {Promise<Response|undefined>}
 */
const getCachedResponse = async (request, matchPath) => {
  const cache = await caches.open(CACHE_NAME);
  if (matchPath) {
    const hit = await cache.match(matchPath);
    if (hit) return hit;
  }
  return caches.match(request);
};

/**
 * Returns an application-level JSON error Response (status 200 with error
 * body) suitable for non-GET offline scenarios.
 * @param {string} message
 * @returns {Response}
 */
const jsonErrorResponse = (message) => {
  const r = new Response(JSON.stringify({ status: 'error', message }));
  r.headers.set('Content-Type', 'application/json');
  return r;
};

self.addEventListener('fetch', (event) => {
  // Network-first strategy with graceful offline / maintenance fallback.
  event.respondWith(
    (async () => {
      // Notify the controlling client about the in-flight request so the
      // loading animation can reflect progress.  Fire-and-forget: we do not
      // await this side-effect so it never delays the main response.
      if (event.clientId && event.request.url.startsWith(self.location.origin)) {
        clients.get(event.clientId).then((client) => {
          if (client)
            client.postMessage({
              status: 'loader',
              path: event.request.url.slice(self.location.origin.length),
            });
        });
      }

      try {
        // 1. Prefer a navigation preload response when available.
        const preloadResponse = await event.preloadResponse;
        if (preloadResponse) return preloadResponse;

        // 2. Go to the network.
        return await fetch(event.request);
      } catch (networkError) {
        // The network request failed (offline, timeout, DNS failure …).
        // We intentionally do NOT check `navigator.onLine` here because
        // that API is unavailable in service worker scope on some browsers.
        // The thrown TypeError is a reliable signal that the network is down.
        console.error('[SW] fetch failed — serving from cache', event.request.url, networkError);

        const isGet = event.request.method.toUpperCase() === 'GET';

        // 3. Try to serve from the precache (exact URL or best-match path).
        const matchPath = PRE_CACHED_RESOURCES.find((p) => event.request.url.includes(p.replace('/index.html', '')));
        const cached = await getCachedResponse(event.request, matchPath);
        if (cached) return cached;

        // 4. Serve the offline fallback page for GET navigation requests.
        if (isGet) {
          try {
            const offlineCache = await caches.open(CACHE_NAME);
            const offlinePage = await offlineCache.match(`${proxyPrefix()}/offline/index.html`);
            if (offlinePage) return offlinePage;

            // 5. If there is no offline page either, serve the maintenance page.
            const maintenancePage = await offlineCache.match(`${proxyPrefix()}/maintenance/index.html`);
            if (maintenancePage) return maintenancePage;
          } catch (cacheError) {
            console.error('[SW] cache lookup failed', cacheError);
          }
        }

        // 6. Non-GET or no cached page available — return a JSON error body
        //    so callers receive a parseable response instead of a hard failure.
        return jsonErrorResponse(networkError.message);
      }
    })(),
  );
});
