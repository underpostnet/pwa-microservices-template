/**
 * Utility class for authentication state management and session lifecycle control.
 * This class is designed to be used as a singleton instance (exported as 'Auth').
 * @module src/client/components/core/Auth.js
 * @namespace AuthClient
 */

import { UserMock, UserService } from '../../services/user/user.service.js';
import { Account } from './Account.js';
import { AppDb } from './AppDb.js';
import { loggerFactory } from './Logger.js';
import { LogIn } from './LogIn.js';
import { LogOut } from './LogOut.js';
import { NotificationManager } from './NotificationManager.js';
import { SearchBox } from './SearchBox.js';
import { Translate } from './Translate.js';
import { s } from './VanillaJs.js';

const logger = loggerFactory(import.meta, { trace: true });

/**
 * Decodes a JWT payload (without verification — trust is handled server-side).
 * Used client-side only to extract `refreshExpiresAt` for local TTL checks.
 *
 * @param {string} token
 * @returns {object|null}
 * @memberof AuthClient
 */
const decodeJwtPayload = (token) => {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
};

/**
 * Manages user authentication state, tokens, and session lifecycle.
 * @memberof AuthClient
 */
class Auth {
  /**
   * The current user access token (JWT).
   * @type {string}
   * @method
   */
  #token = '';

  /**
   * The token for anonymous guest sessions.
   * @type {string}
   * @method
   */
  #guestToken = '';

  /**
   * Timeout ID for the token refresh schedule.
   * @type {number | undefined}
   * @method
   */
  #refreshTimeout;

  /**
   * Creates an instance of Auth.
   */
  constructor() {
    // Private fields are initialized above.
  }

  // --- Token Management ---

  /**
   * Sets the user's access token.
   * @memberof AuthClient.Auth
   * @param {string} [value=''] - The JWT token value.
   * @returns {string} The set token value.
   */
  setToken(value = '') {
    return (this.#token = value);
  }

  /**
   * Clears the user's access token.
   * @memberof AuthClient.Auth
   * @returns {string} An empty string.
   */
  deleteToken() {
    return (this.#token = '');
  }

  /**
   * Gets the user's access token.
   * @memberof AuthClient.Auth
   * @returns {string} The JWT token.
   */
  getToken() {
    return this.#token;
  }

  /**
   * Sets the anonymous guest token.
   * @memberof AuthClient.Auth
   * @param {string} [value=''] - The guest token value.
   * @returns {string} The set guest token value.
   */
  setGuestToken(value = '') {
    return (this.#guestToken = value);
  }

  /**
   * Clears the anonymous guest token.
   * @memberof AuthClient.Auth
   * @returns {string} An empty string.
   */
  deleteGuestToken() {
    return (this.#guestToken = '');
  }

  /**
   * Gets the anonymous guest token.
   * @memberof AuthClient.Auth
   * @returns {string} The guest token.
   */
  getGuestToken() {
    return this.#guestToken;
  }

  /**
   * Generates the JWT header string (e.g., "Bearer [token]") using the active token (user or guest).
   * @memberof AuthClient.Auth
   * @returns {string} The Bearer token string or an empty string.
   */
  getJWT() {
    if (this.getToken()) return `Bearer ${this.getToken()}`;
    if (this.getGuestToken()) return `Bearer ${this.getGuestToken()}`;
    return '';
  }

  /**
   * Decodes the payload section of a JWT token.
   * @static
   * @memberof AuthClient.Auth
   * @param {string} token - The JWT string.
   * @returns {object | null} The decoded JWT payload object, or null on failure.
   */
  static decodeJwt(token) {
    try {
      // Uses atob for base64 decoding of the middle part of the JWT
      return JSON.parse(atob(token.split('.')[1]));
    } catch (e) {
      logger.error('Failed to decode JWT:', e);
      return null;
    }
  }

  // --- Session Management ---

  /**
   * Schedules the access token to be refreshed shortly before it expires.
   * Clears any existing refresh timeout before setting a new one.
   * @memberof AuthClient.Auth
   * @returns {void}
   */
  scheduleTokenRefresh() {
    if (this.#refreshTimeout) {
      clearTimeout(this.#refreshTimeout);
      this.#refreshTimeout = undefined;
    }

    const currentToken = this.getToken();
    if (!currentToken) return;

    const payload = Auth.decodeJwt(currentToken);
    if (!payload || !payload.refreshExpiresAt) return; // Requires refreshExpiresAt in milliseconds

    const expiresIn = payload.refreshExpiresAt - Date.now();
    const refreshBuffer = 2 * 60 * 1000; // 2 minutes buffer before expiry
    const refreshIn = expiresIn - refreshBuffer;

    logger.info(`Token refresh scheduled in ${refreshIn / (1000 * 60)} minutes`);

    if (refreshIn <= 0) {
      logger.warn('Token already expired or too close to expiry, skipping refresh schedule.');
      return;
    }

    this.#refreshTimeout = setTimeout(async () => {
      const { data, status } = await UserService.get({ id: 'auth' }); // API call to get a fresh token
      if (status === 'success' && data?.token) {
        logger.info('Successfully refreshed access token.');
        this.setToken(data.token);
        localStorage.setItem('jwt', data.token);
        this.scheduleTokenRefresh(); // Schedule the next refresh
      } else {
        logger.warn('Token refresh failed, attempting session out.');
        this.sessionOut();
      }
    }, refreshIn);
  }

  /**
   * Establishes a user session (logged-in) or falls back to a guest session.
   *
   * Fast-path optimisation: if AppDb holds a non-expired token whose
   * `refreshExpiresAt` claim (set by the server in `jwtSign`) is still in
   * the future, the `/auth` network call is skipped entirely.
   *
   * For **guest** sessions (stateless JWT-only since Valkey was removed),
   * the token is fully self-validating — there is no server state to query.
   * The client simply re-uses the token until `refreshExpiresAt` passes.
   *
   * Flow:
   *   1. Check AppDb for a cached user token (fast-path, no network).
   *   2. If no fast-path hit, validate with the backend.
   *   3. On failure, check a cached guest token (no network needed).
   *   4. On guest miss, create a new guest session (`sessionOut`).
   *
   * @memberof AuthClient.Auth
   * @param {object} [userServicePayload] - Payload from a successful login/signup call.
   * @returns {Promise<{user: object}>} Resolves to the current user object.
   */
  async sessionIn(userServicePayload) {
    try {
      // --- Fast-path: locally valid user token (no network round-trip) ---
      if (!userServicePayload) {
        const stored = await AppDb.session.get('jwt');
        if (stored?.value) {
          // AppDb.get() prunes entries whose `expiresAt` has passed.  We
          // set expiresAt = refreshExpiresAt from the JWT so the fast-path
          // lifetime matches the server-side refresh window exactly.
          this.setToken(stored.value);
          this.renderSessionUI();
          this.scheduleTokenRefresh();
          logger.info('sessionIn: fast-path from AppDb (no network)');
          return { user: { role: 'user' } };
        }
      }

      // --- Network path ---
      let token = userServicePayload?.data?.token;
      if (!token) {
        const stored = await AppDb.session.get('jwt');
        token = stored?.value ?? null;
      }

      if (token) {
        this.setToken(token);

        const result = userServicePayload ? userServicePayload : await UserService.get({ id: 'auth' });

        const { status, data, message } = result;

        if (status === 'success' && data.token) {
          this.setToken(data.token);
          // Use refreshExpiresAt from the JWT as the AppDb TTL so the
          // fast-path lifetime is exactly aligned with the server's refresh
          // window.  Fall back to 30 min if the claim is missing.
          const claims = decodeJwtPayload(data.token);
          const expiresAt = claims?.refreshExpiresAt ?? Date.now() + 30 * 60 * 1000;
          await AppDb.session.put({ key: 'jwt', value: data.token, expiresAt });
          LogIn.Scope.user.main.model.user = {};
          this.renderSessionUI();
          await LogIn.Trigger({ user: data.user });
          await Account.updateForm(data.user);
          this.scheduleTokenRefresh();
          return { user: data.user };
        } else if (message && message.match('expired')) {
          logger.warn('User session token expired.');
          setTimeout(() => {
            s(`.main-btn-log-in`).click();
            NotificationManager.Push({
              html: Translate.Render(`expired-session`),
              status: 'warning',
            });
          });
        }
      }

      // Cleanup failed user session attempt.
      this.deleteToken();
      await AppDb.session.delete('jwt');

      // --- Guest fast-path (fully offline — stateless JWT) ---
      // Guest sessions are self-contained in the JWT payload; no Valkey
      // lookup needed.  Simply check whether the token is still fresh.
      const storedGuest = await AppDb.session.get('jwt.g');
      const guestToken = storedGuest?.value ?? null;
      if (guestToken) {
        this.setGuestToken(guestToken);
        // Re-mint guest identity from JWT claims (no network round-trip).
        const claims = decodeJwtPayload(guestToken);
        const guestUser = {
          _id: claims?._id ?? '',
          username: claims?.email?.split('@')[0] ?? 'guest',
          email: claims?.email ?? '',
          role: 'guest',
          emailConfirmed: false,
          profileImageId: null,
          publicProfile: false,
          briefDescription: '',
        };
        LogIn.Scope.user.main.model.user = {};
        await LogIn.Trigger({ user: guestUser });
        await Account.updateForm(guestUser);
        return { user: guestUser };
      }

      return await this.sessionOut();
    } catch (error) {
      logger.error('Error during sessionIn process:', error);
      return { user: UserMock.default };
    }
  }

  /**
   * Ends the current user session (logout) and initiates a new anonymous
   * guest session.
   *
   * Cleans up all stored tokens from AppDb (namespaced; does not affect
   * other apps on the same origin).
   *
   * @memberof AuthClient.Auth
   * @returns {Promise<object>} Resolves to the newly created guest session data.
   */
  async sessionOut() {
    // 1. End user session
    try {
      const result = await UserService.delete({ id: 'logout' });
      await AppDb.session.delete('jwt');
      SearchBox.RecentResults.clear();
      this.deleteToken();
      if (this.#refreshTimeout) {
        clearTimeout(this.#refreshTimeout);
        this.#refreshTimeout = undefined;
      }
      this.renderGuestUi();
      LogIn.Scope.user.main.model.user = {};
      await LogOut.Trigger(result);
    } catch (error) {
      logger.error('Error during user logout:', error);
    }

    // 2. Start guest session
    try {
      await AppDb.session.delete('jwt.g');
      this.deleteGuestToken();
      const result = await UserService.post({ id: 'guest' });

      if (result.status === 'success' && result.data.token) {
        // Use refreshExpiresAt from the JWT claim as the AppDb TTL so the
        // guest token is evicted at exactly the same time the server would
        // reject it.  Fall back to 30 min if the claim is absent.
        const guestClaims = decodeJwtPayload(result.data.token);
        const guestExpiresAt = guestClaims?.refreshExpiresAt ?? Date.now() + 30 * 60 * 1000;
        await AppDb.session.put({
          key: 'jwt.g',
          value: result.data.token,
          expiresAt: guestExpiresAt,
        });
        this.setGuestToken(result.data.token);
        return await this.sessionIn();
      } else {
        logger.error('Failed to get a new guest token.');
        return { user: UserMock.default };
      }
    } catch (error) {
      logger.error('Error during guest session creation:', error);
      return { user: UserMock.default };
    }
  }

  // --- UI Rendering ---

  /**
   * Renders the UI for a logged-in user (hides Log In/Sign Up, shows Log Out/Account).
   * Also closes any active login/signup modals.
   * @memberof AuthClient.Auth
   * @returns {void}
   */
  renderSessionUI() {
    s(`.main-btn-log-in`).style.display = 'none';
    s(`.main-btn-sign-up`).style.display = 'none';
    s(`.main-btn-log-out`).style.display = null;
    s(`.main-btn-account`).style.display = null;
    if (s(`.main-btn-public-profile`)) s(`.main-btn-public-profile`).style.display = null;
    setTimeout(() => {
      // Close any open login/signup modals
      if (s(`.modal-log-in`)) s(`.btn-close-modal-log-in`).click();
      if (s(`.modal-sign-up`)) s(`.btn-close-modal-sign-up`).click();
    });
  }

  /**
   * Renders the UI for a guest user (shows Log In/Sign Up, hides Log Out/Account).
   * Also closes any active logout/account modals.
   * @memberof AuthClient.Auth
   * @returns {void}
   */
  renderGuestUi() {
    s(`.main-btn-log-in`).style.display = null;
    s(`.main-btn-sign-up`).style.display = null;
    s(`.main-btn-log-out`).style.display = 'none';
    s(`.main-btn-account`).style.display = 'none';
    if (s(`.main-btn-public-profile`)) s(`.main-btn-public-profile`).style.display = 'none';
    setTimeout(() => {
      // Close any open logout/account modals
      if (s(`.modal-log-out`)) s(`.btn-close-modal-log-out`).click();
      if (s(`.modal-account`)) s(`.btn-close-modal-account`).click();
    });
  }
}

// Export a singleton instance of the Auth class to maintain the original utility object access pattern.
const AuthSingleton = new Auth();

export { AuthSingleton as Auth };
