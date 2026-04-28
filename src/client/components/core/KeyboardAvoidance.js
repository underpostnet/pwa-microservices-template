/**
 * Mobile virtual keyboard avoidance utility.
 *
 * On mobile browsers, when the software keyboard appears it reduces
 * `window.visualViewport.height`.  Without compensation, the keyboard
 * can cover modals and form inputs so the user cannot see what they type.
 *
 * This module attaches to `window.visualViewport` resize/scroll events and
 * translates a target element upward by the amount of space the keyboard has
 * consumed.  A debounce is applied so that rapid `resize` events (common on
 * Android) do not cause visual jitter.
 *
 * Usage:
 * ```js
 * import { initKeyboardAvoidance } from './KeyboardAvoidance.js';
 *
 * // Attach when a modal opens:
 * const cleanup = initKeyboardAvoidance(document.querySelector('.my-modal'));
 *
 * // Detach when the modal closes:
 * cleanup();
 * ```
 *
 * @module src/client/components/core/KeyboardAvoidance.js
 * @namespace KeyboardAvoidanceModule
 */

/**
 * Minimum keyboard height in pixels below which we consider the keyboard
 * to be hidden.  Values smaller than this are treated as OS chrome
 * (address bar resize, etc.) and ignored.
 *
 * @constant {number}
 * @memberof KeyboardAvoidanceModule
 */
const MIN_KEYBOARD_HEIGHT_PX = 50;

/**
 * Debounce delay in milliseconds applied to the `resize` handler.
 * Prevents excessive style recalculations when the keyboard animates in.
 *
 * @constant {number}
 * @memberof KeyboardAvoidanceModule
 */
const DEBOUNCE_MS = 32;

/**
 * Attaches `visualViewport` listeners to translate `targetEl` when the
 * mobile software keyboard appears.
 *
 * The function is a no-op in environments that do not support the
 * `visualViewport` API (desktop browsers, some older mobile browsers).
 *
 * @param {HTMLElement} targetEl - The element to translate (typically a
 *   modal container or form wrapper).
 * @param {object}  [options]
 * @param {number}  [options.debounceMs=32]       - Debounce delay in ms.
 * @param {number}  [options.minKeyboardPx=50]    - Minimum offset to treat
 *   as a real keyboard appearance.
 * @param {string}  [options.transitionStyle='transform 0.15s ease-out'] -
 *   CSS transition applied to `targetEl` during keyboard animations.
 * @returns {function(): void} Cleanup function — call when the element is
 *   unmounted or the modal closes to remove the event listeners.
 *
 * @memberof KeyboardAvoidanceModule
 *
 * @example
 * // Inside a modal's open() method:
 * this._kbCleanup = initKeyboardAvoidance(this._el);
 *
 * // Inside the modal's close() method:
 * if (this._kbCleanup) { this._kbCleanup(); this._kbCleanup = null; }
 */
export function initKeyboardAvoidance(
  targetEl,
  {
    debounceMs = DEBOUNCE_MS,
    minKeyboardPx = MIN_KEYBOARD_HEIGHT_PX,
    transitionStyle = 'transform 0.15s ease-out',
  } = {},
) {
  // Feature-detect visualViewport.  When unavailable, return a no-op cleanup.
  if (!window.visualViewport || !targetEl) return () => {};

  // Apply transition so movement feels natural.
  const previousTransition = targetEl.style.transition;
  targetEl.style.transition = transitionStyle;

  let debounceTimer = null;

  /**
   * Computes the vertical offset caused by the software keyboard and
   * applies a CSS translateY correction to `targetEl`.
   *
   * @returns {void}
   * @memberof KeyboardAvoidanceModule
   */
  const update = () => {
    const offset = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;

    if (offset > minKeyboardPx) {
      // Keyboard is visible — push the element up.
      targetEl.style.transform = `translateY(-${Math.round(offset)}px)`;
    } else {
      // Keyboard is hidden — restore original position.
      targetEl.style.transform = '';
    }
  };

  /**
   * Debounced wrapper for `update`.
   * @returns {void}
   */
  const onViewportChange = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, debounceMs);
  };

  window.visualViewport.addEventListener('resize', onViewportChange);
  window.visualViewport.addEventListener('scroll', onViewportChange);

  // Run once immediately to handle the case where the keyboard was already
  // open when this function was called.
  update();

  /**
   * Cleanup function.  Removes all listeners and restores the element's
   * original styles.
   *
   * @returns {void}
   */
  return () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    window.visualViewport.removeEventListener('resize', onViewportChange);
    window.visualViewport.removeEventListener('scroll', onViewportChange);
    // Restore previous styles.
    targetEl.style.transform = '';
    targetEl.style.transition = previousTransition;
  };
}

export default initKeyboardAvoidance;
