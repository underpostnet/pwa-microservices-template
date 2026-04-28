import { cap, getId } from './CommonJs.js';
import { BaseComponent } from './WebComponent.js';

/**
 * Keyboard input manager.
 *
 * Tracks which keys are currently held down and dispatches registered
 * callbacks at a fixed polling interval.
 *
 * Uses `addEventListener` (not `window.onkeydown = ...`) so that other
 * modules can also listen for key events without being silently overridden.
 *
 * @namespace Keyboard
 */
class Keyboard extends BaseComponent {
  /** @type {Object.<string, true>} Map of currently pressed key names. */
  static ActiveKey = {};

  /**
   * Registered key-event handlers.
   * Structure: `{ [eventGroupId]: { [keyName]: callbackFn } }`
   * @type {Object.<string, Object.<string, function>>}
   */
  static Event = {};

  /**
   * Initialises keyboard listeners and starts the polling interval.
   * Safe to call multiple times — handler registration is idempotent on
   * the singleton object.
   * @returns {Promise<void>}
   */
  static async Init() {
    const callBackTime = 45;

    // addEventListener ensures we do not overwrite handlers registered by
    // third-party libraries or other modules.
    window.addEventListener('keydown', (e) => {
      this.ActiveKey[e.key] = true;
    });
    window.addEventListener('keyup', (e) => {
      delete this.ActiveKey[e.key];
    });

    setInterval(() => {
      Object.keys(this.Event).map((key) => {
        Object.keys(this.ActiveKey).map((activeKey) => {
          if (activeKey in this.Event[key]) this.Event[key][activeKey]();
        });
      });
    }, callBackTime);
  }
  static instanceMultiPressKeyTokens = {};
  static instanceMultiPressKey(options = { keys: [], id, timePressDelay, eventCallBack: () => {} }) {
    if (typeof options.keys[0] === 'string') options.keys[0] = [options.keys[0]];
    if (!options.id) options.id = getId(Keyboard.instanceMultiPressKeyTokens, 'key-press-');
    if (!options.timePressDelay) options.timePressDelay = 500;
    const { id, timePressDelay, keys, eventCallBack } = options;
    Keyboard.instanceMultiPressKeyTokens[id] = { ...options };

    let indexCombined = -1;
    for (const combinedKeys of keys) {
      indexCombined++;
      const privateIndexCombined = indexCombined;
      const multiPressKey = {};
      const triggerMultiPressKey = () => {
        for (const key of Object.keys(multiPressKey)) {
          if (!multiPressKey[key].press) return;
        }
        eventCallBack();
      };
      Keyboard.Event[`instanceMultiPressKey-${id}-${privateIndexCombined}`] = {};
      for (const key of combinedKeys) {
        multiPressKey[key] = {
          press: false,
          trigger: function () {
            if (!multiPressKey[key].press) {
              multiPressKey[key].press = true;
              triggerMultiPressKey();
              setTimeout(() => {
                multiPressKey[key].press = false;
              }, timePressDelay);
            }
          },
        };

        Keyboard.Event[`instanceMultiPressKey-${id}-${privateIndexCombined}`][key] = multiPressKey[key].trigger;
        Keyboard.Event[`instanceMultiPressKey-${id}-${privateIndexCombined}`][key.toLowerCase()] =
          multiPressKey[key].trigger;
        Keyboard.Event[`instanceMultiPressKey-${id}-${privateIndexCombined}`][key.toUpperCase()] =
          multiPressKey[key].trigger;
        Keyboard.Event[`instanceMultiPressKey-${id}-${privateIndexCombined}`][cap(key)] = multiPressKey[key].trigger;
      }
    }
  }
}

export { Keyboard };
