import { newInstance } from './CommonJs.js';
import { loggerFactory } from './Logger.js';
import { getResponsiveData } from './VanillaJs.js';

import { BaseComponent } from './WebComponent.js';
const logger = loggerFactory(import.meta);

/**
 * Singleton responsive-state manager.
 *
 * Listens for viewport resize and screen-orientation changes, recomputes
 * layout breakpoint data, and broadcasts the new state to all registered
 * event callbacks.
 *
 * Using `addEventListener` (not `window.onresize = ...`) ensures that other
 * modules can also listen for resize events without being silently overridden.
 *
 * @namespace Responsive
 */
class Responsive extends BaseComponent {
  /** @type {object} Current responsive breakpoint data snapshot. */
  static Data = {};
  /** @type {Object.<string, function>} Immediate resize callbacks keyed by id. */
  static Event = {};
  /** @type {Object.<string, function>} Debounced resize callbacks keyed by id. */
  static DelayEvent = {};
  /** @type {typeof ResizeObserver} ResizeObserver constructor reference. */
  static Observer = ResizeObserver;

  /**
   * Returns a deep copy of the current responsive data snapshot.
   * @returns {object}
   */
  static getResponsiveData() {
    return newInstance(this.Data);
  }

  /**
   * Returns a deep copy of the current responsive data scaled by dimAmplitude.
   * @param {{ dimAmplitude: number }} options
   * @returns {object}
   */
  static getResponsiveDataAmplitude(options) {
    const { dimAmplitude } = options;
    const ResponsiveDataAmplitude = newInstance(this.Data);
    ResponsiveDataAmplitude.minValue = ResponsiveDataAmplitude.minValue * dimAmplitude;
    ResponsiveDataAmplitude.maxValue = ResponsiveDataAmplitude.maxValue * dimAmplitude;
    ResponsiveDataAmplitude.width = ResponsiveDataAmplitude.width * dimAmplitude;
    ResponsiveDataAmplitude.height = ResponsiveDataAmplitude.height * dimAmplitude;
    return ResponsiveDataAmplitude;
  }

  /**
   * Recomputes breakpoint data and fires all registered Event callbacks when
   * the viewport dimensions change.  Pass `force = true` to always fire even
   * when the computed values are unchanged.
   * @param {boolean} [force]
   */
  static resizeCallback(force) {
    const Data = getResponsiveData();
    if (force === true || Data.minValue !== Responsive.Data.minValue || Data.maxValue !== Responsive.Data.maxValue) {
      Responsive.Data = Data;
      Responsive.triggerEvents();
    }
  }

  /** @private Internal counter used to detect the end of a resize burst. */
  static resize = 0;

  /**
   * Initialises resize and orientation listeners.
   *
   * Uses `addEventListener` so that other modules can also attach resize
   * listeners without risk of overwriting this handler via `onresize`.
   */
  static async Init() {
    Responsive.resizeCallback();

    /**
     * Internal resize handler.  Fires immediately and once more after a
     * 750 ms debounce to catch the settled state.
     * @param {Event} e
     * @param {boolean} [force]
     */
    const onResize = (e, force) => {
      Responsive.resize++;
      const resize = Responsive.resize;
      Responsive.resizeCallback(force);
      setTimeout(() => {
        if (resize === Responsive.resize) {
          Responsive.resizeCallback(force);
          Responsive.resize = 0;
          for (const event of Object.keys(Responsive.DelayEvent)) Responsive.DelayEvent[event]();
        }
      }, 750);
    };

    // Store reference so callers can force a resize trigger programmatically.
    Responsive._onResize = onResize;
    window.addEventListener('resize', onResize);
    // alternative option
    // this.Observer = new ResizeObserver(this.resizeCallback);
    // this.Observer.observe(document.documentElement);

    // Check if screen.orientation is available before adding event listener
    if (
      typeof screen !== 'undefined' &&
      screen.orientation &&
      typeof screen.orientation.addEventListener === 'function'
    ) {
      screen.orientation.addEventListener('change', (event) => {
        const type = event.target.type; // landscape-primary | portrait-primary
        const angle = event.target.angle; // 90 degrees
        logger.info(`ScreenOrientation change: ${type}, ${angle} degrees.`);
        setTimeout(() => Responsive._onResize({}, true));
        Responsive.triggerEventsOrientation();
      });
    }
    Responsive.matchMediaOrientationInstance = matchMedia('screen and (orientation:portrait)');

    // Use addEventListener (not .onchange assignment) so other listeners
    // attached to the same MediaQueryList are not overwritten.
    Responsive.matchMediaOrientationInstance.addEventListener('change', (e) => {
      logger.info('orientation change', Responsive.matchMediaOrientationInstance.matches ? 'portrait' : 'landscape');
      setTimeout(() => Responsive._onResize({}, true));
      Responsive.triggerEventsOrientation();
    });
  }
  static triggerEventsOrientation() {
    for (const event of Object.keys(this.orientationEvent)) this.orientationEvent[event]();
    setTimeout(() => {
      window.onresize();
      for (const event of Object.keys(this.orientationDelayEvent)) this.orientationDelayEvent[event]();
    }, 1500);
  }
  static triggerEvents(keyEvent) {
    if (keyEvent) return this.Event[keyEvent]();
    return Object.keys(this.Event).map((key) => this.Event[key]());
  }
  static orientationEvent = {};
  static orientationDelayEvent = {};
}

export { Responsive };
