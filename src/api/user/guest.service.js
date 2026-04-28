/**
 * Centralized guest user management for server-side anonymous sessions.
 *
 * Guest sessions are **stateless**: the full guest identity is encoded inside
 * a signed JWT — no database or cache entry is created.  Validation is pure
 * cryptography, making guest sessions horizontally scalable.
 *
 * Industry references: Auth0 anonymous identities, Firebase anonymous auth,
 * Supabase anonymous sign-in all follow the same principle.
 *
 * @module src/api/user/guest.service.js
 * @namespace GuestUserServer
 */

import crypto from 'crypto';
import { jwtSign, getBearerToken } from '../../server/auth.js';
import { UserDto } from './user.model.js';
import { selectDtoFactory } from '../../server/valkey.js';

/**
 * @typedef {object} GuestUserShape
 * @property {string} _id             - Guest identity: `"guest" + 24-char hex`.
 * @property {string} username         - Human-readable alias: `"guest" + last 5 hex chars`.
 * @property {string} email            - Synthetic e-mail: `"<hex>@<host>"`.
 * @property {'guest'} role            - Always `'guest'`.
 * @property {false}  emailConfirmed   - Always `false` for guests.
 * @property {null}   profileImageId   - Always `null` for guests.
 * @property {false}  publicProfile    - Always `false` for guests.
 * @property {string} briefDescription - Always empty string for guests.
 * @property {string} createdAt        - ISO 8601 creation timestamp.
 * @property {string} updatedAt        - ISO 8601 update timestamp.
 */

/**
 * @typedef {object} GuestAuthResult
 * @property {string}        token - Signed JWT encoding the guest identity.
 * @property {GuestUserShape} user  - DTO-filtered guest user object.
 */

/**
 * Builds a transient guest user object from a hex ID.
 *
 * No database write is performed.  The returned object is the single source
 * of truth for the anonymous session shape used throughout the application.
 *
 * @memberof GuestUserServer
 * @param {string} guestId   - 24-char hex string (12 random bytes via `crypto.randomBytes(12).toString('hex')`).
 * @param {string} host      - Hostname used as the synthetic e-mail domain.
 * @param {Date}   [now]     - Timestamp for `createdAt`/`updatedAt`; defaults to `new Date()`.
 * @returns {GuestUserShape}
 */
const buildGuestUser = (guestId, host, now = new Date()) => ({
  _id: `guest${guestId}`,
  username: `guest${guestId.slice(-5)}`,
  email: `${guestId}@${host}`,
  role: 'guest',
  emailConfirmed: false,
  profileImageId: null,
  publicProfile: false,
  briefDescription: '',
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
});

/**
 * Reconstructs a guest user DTO from JWT claims already verified by the auth
 * middleware.  No database or cache lookup is required.
 *
 * @memberof GuestUserServer
 * @param {{ _id: string, email: string }} jwtUser - `req.auth.user` claims.
 * @returns {GuestUserShape}
 */
const guestUserFromClaims = (jwtUser) => {
  const guestId = jwtUser._id.replace(/^guest/, '');
  const host = jwtUser.email.split('@')[1] ?? 'unknown';
  return buildGuestUser(guestId, host);
};

/**
 * Returns `true` when the JWT user ID belongs to a guest session.
 *
 * @memberof GuestUserServer
 * @param {{ _id: string }} jwtUser - `req.auth.user` claims.
 * @returns {boolean}
 */
const isGuestUser = (jwtUser) => typeof jwtUser?._id === 'string' && jwtUser._id.startsWith('guest');

/**
 * Guest user service — static methods for creating and retrieving anonymous
 * sessions.  All operations are stateless (no DB/cache interaction).
 *
 * @memberof GuestUserServer
 */
class GuestService {
  /**
   * Creates a new guest session: generates a random identity, signs a JWT,
   * and returns the token together with the DTO-filtered user object.
   *
   * Equivalent to `case 'guest'` inside `UserService.post`.
   *
   * @memberof GuestUserServer.GuestService
   * @param {object} req     - Express request (used for `req.ip` and `req.headers['user-agent']`).
   * @param {object} options - Route options containing `host` and `path` (JWT signing context).
   * @returns {GuestAuthResult}
   */
  static create(req, options) {
    const guestId = crypto.randomBytes(12).toString('hex');
    const user = buildGuestUser(guestId, options.host);
    return {
      token: jwtSign(
        UserDto.auth.payload(user, null, req.ip, req.headers['user-agent'], options.host, options.path),
        options,
      ),
      user: selectDtoFactory(user, UserDto.select.get()),
    };
  }

  /**
   * Reconstructs an existing guest session from the verified JWT on the
   * current request.  Returns the token unchanged (no rotation needed for
   * stateless guest sessions).
   *
   * Equivalent to the guest branch inside `UserService.get` (case `'auth'`).
   *
   * @memberof GuestUserServer.GuestService
   * @param {object} req - Express request with `req.auth.user` populated by the auth middleware.
   * @returns {GuestAuthResult}
   */
  static getAuth(req) {
    const guestUser = guestUserFromClaims(req.auth.user);
    return {
      user: selectDtoFactory(guestUser, UserDto.select.get()),
      token: getBearerToken(req),
    };
  }
}

export { GuestService, buildGuestUser, guestUserFromClaims, isGuestUser };
