/**
 * Shared application bootstrap orchestrator.
 *
 * `AppBootstrap.init()` replaces the per-app boilerplate that previously lived
 * in every `*.index.js` entry point:
 *
 * ```js
 * // Before (in each of the 10 *.index.js files):
 * window.onload = () =>
 *   Worker.instance({
 *     router: RouterXxx,
 *     render: async () => {
 *       await Css.Init(...);
 *       await Translate.Init(...);
 *       await Responsive.Init();
 *       await MenuXxx.Init();
 *       await SocketIo.Init();
 *       await LogIn.Init();
 *       // ... etc.
 *     },
 *   });
 *
 * // After (standardised boot with separated concerns):
 * window.onload = () =>
 *   AppBootstrap.init({
 *     router: RouterXxx,
 *     render: async () => {          // shell only — fast, no network
 *       await Css.Init(...);
 *       await Translate.Init(...);
 *       await Responsive.Init();
 *       await MenuXxx.Init();
 *     },
 *     sessionInit: async () => {     // deferred — runs after splash is removed
 *       await SocketIo.Init();
 *       await LogIn.Init();
 *       await LogOut.Init();
 *       await SignUp.Init();
 *       await Keyboard.Init();
 *     },
 *   });
 * ```
 *
 * Boot sequence (designed for minimum Time-To-Interactive):
 *   1. Kick off SW registration in the background (fire-and-forget).
 *   2. `render()` — paint the app shell (CSS, theme, layout, menu).
 *   3. `LoadRouter` — resolve the current route.
 *   4. Remove the splash screen → user sees the app.
 *   5. `sessionInit()` — session, auth, socket init (runs after splash).
 *   6. Settle SW registration promise.
 *   7. Set `window.serviceWorkerReady = true`.
 *
 * @module src/client/components/core/AppBootstrap.js
 * @namespace AppBootstrapModule
 */

import { LoadingAnimation } from './LoadingAnimation.js';
import { loggerFactory } from './Logger.js';
import { LoadRouter } from './Router.js';
import { Worker } from './Worker.js';

const logger = loggerFactory(import.meta);

// ---------------------------------------------------------------------------
// AppRunner
// ---------------------------------------------------------------------------

/**
 * Boot-sequence runner for all app entry points.
 * @memberof AppRunnerModule
 */
class AppRunnerClass {
  /**
   * Runs the application using the standardised boot sequence.
   *
   * Separating `render` from `sessionInit` ensures the splash screen is
   * removed before any network-bound session / auth calls are made, giving
   * the user a fast first paint regardless of connectivity.
   *
   * @param {object}   options
   * @param {function(): object}            options.router      - Returns the router instance.
   * @param {function(): Promise<void>}     options.render      - Renders the app shell
   *   (CSS themes, translations, responsive layout, menu).  Must NOT make
   *   session-related network calls.
   * @param {function(): Promise<void>}    [options.sessionInit] - Performs session / auth /
   *   socket initialisation.  Runs **after** the splash screen is removed so
   *   it never delays the first paint.  Omit to preserve legacy behaviour.
   * @returns {Promise<void>}
   * @memberof AppRunnerModule.AppRunnerClass
   */
  async run({ router, render, sessionInit }) {
    try {
      // 1. SW registration — fire-and-forget so it never blocks render.
      const swReady = Worker.status()
        .then((isInstall) => {
          if (!isInstall) return Worker.install();
        })
        .catch((err) => logger.error('SW init error (non-fatal):', err));

      // 2. Register online/offline listeners.
      window.addEventListener('online', () => logger.warn('ononline'));
      window.addEventListener('offline', () => logger.warn('onoffline'));

      // 3. Wire up SW message bridge.
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          logger.info('SW controller changed.');
        });
        navigator.serviceWorker.ready.then((worker) => {
          logger.info('Service Worker Ready', worker);
          navigator.serviceWorker.addEventListener('message', (event) => {
            logger.info('SW message', event.data);
            if (event.data?.status === 'loader') LoadingAnimation.RenderCurrentSrcLoad(event);
          });
        });
      }

      // 4. Route instance (needed before LoadRouter).
      const routerInstance = router();

      // 5. Paint the shell.
      await render();

      // 6. Route to the current URL.
      await LoadRouter(routerInstance);

      // 7. Remove splash → user sees the app immediately.
      LoadingAnimation.removeSplashScreen();

      // 8. Session / auth / socket init (after splash, so never blocks paint).
      if (typeof sessionInit === 'function') {
        await sessionInit();
      }

      // 9. Settle SW promise.
      await swReady;
      window.serviceWorkerReady = true;

      logger.info('AppRunner: boot complete.');
    } catch (err) {
      logger.error('AppRunner: unhandled boot error', err);
    }
  }
}

/**
 * Singleton `AppRunner` instance.
 * @type {AppRunnerClass}
 * @memberof AppRunnerModule
 */
export const AppRunner = new AppRunnerClass();

export default AppRunner;
