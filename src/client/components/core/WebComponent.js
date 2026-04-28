/**
 * Base class for all custom HTML elements in this project.
 *
 * `BaseComponent` extends the native `HTMLElement` interface with:
 *   - A declarative **`template()`** method: return an HTML string and the
 *     shadow DOM (or light DOM) is kept in sync automatically.
 *   - **Reactive props** via `static get observedProps()` and automatic
 *     `propsChangedCallback()` when any listed property changes.
 *   - A **`css()`** hook for scoped styles injected into the shadow root once.
 *   - `emit(name, detail)` convenience method for dispatching custom events
 *     that bubble and cross shadow boundaries (`composed: true`).
 *   - `query(sel)` / `queryAll(sel)` helpers scoped to the shadow root.
 *
 * ## Usage
 *
 * ```js
 * import { BaseComponent } from './WebComponent.js';
 *
 * class MyCard extends BaseComponent {
 *   // Shadow DOM is opt-in; set to false for light DOM.
 *   static useShadow = true;
 *
 *   // Attributes that trigger attributeChangedCallback (standard WC API).
 *   static get observedAttributes() { return ['title', 'active']; }
 *
 *   // Props that trigger propsChangedCallback (JS-side reactive properties).
 *   static get observedProps() { return ['count']; }
 *
 *   // Scoped CSS (injected into shadow root once, not re-evaluated on updates).
 *   css() {
 *     return css`
 *       :host { display: block; padding: 12px; border: 1px solid #ccc; }
 *       h3    { margin: 0 0 8px; }
 *     `;
 *   }
 *
 *   // Declarative template — called on connect and after every prop/attr change.
 *   template() {
 *     return html`
 *       <h3>${this.getAttribute('title') ?? 'Untitled'}</h3>
 *       <p>Count: ${this.count ?? 0}</p>
 *       ${this.hasAttribute('active') ? html`<span class="badge">Active</span>` : ''}
 *     `;
 *   }
 *
 *   connectedCallback() {
 *     super.connectedCallback();          // always call super
 *     this.addEventListener('click', () => {
 *       this.count = (this.count ?? 0) + 1;  // triggers propsChangedCallback
 *       this.emit('card-click', { count: this.count });
 *     });
 *   }
 * }
 *
 * customElements.define('my-card', MyCard);
 * export { MyCard };
 * ```
 *
 * ## Registration helper
 *
 * ```js
 * import { defineComponent } from './WebComponent.js';
 * defineComponent('my-card', MyCard);
 * ```
 *
 * `defineComponent` is idempotent — it silently skips registration if the tag
 * is already defined, which prevents errors during hot-reload.
 *
 * @module src/client/components/core/WebComponent.js
 * @namespace WebComponentCore
 */

// ---------------------------------------------------------------------------
// BaseComponent
// ---------------------------------------------------------------------------

/**
 * Reactive base class for custom HTML elements.
 *
 * @extends HTMLElement
 * @memberof WebComponentCore
 */
class BaseComponent extends HTMLElement {
  /**
   * Whether to use Shadow DOM.  Set to `false` on the subclass for light DOM.
   * @type {boolean}
   */
  static useShadow = true;

  /** @type {ShadowRoot | this} */
  #root = null;

  /** @type {boolean} Tracks whether CSS has been injected into the root. */
  #cssInjected = false;

  /** @type {ProxyHandler<BaseComponent>} Prop-change proxy backing storage. */
  #props = {};

  constructor() {
    super();
    if (new.target.useShadow) {
      this.#root = this.attachShadow({ mode: 'open' });
    } else {
      this.#root = this;
    }

    // Create a reactive proxy for JS-side props listed in `observedProps`.
    const observedProps = new.target.observedProps ?? [];
    if (observedProps.length > 0) {
      for (const prop of observedProps) {
        Object.defineProperty(this, prop, {
          get: () => this.#props[prop],
          set: (value) => {
            const old = this.#props[prop];
            if (old !== value) {
              this.#props[prop] = value;
              this.propsChangedCallback(prop, old, value);
              this.#update();
            }
          },
          enumerable: true,
          configurable: true,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  connectedCallback() {
    this.#injectCss();
    this.#update();
  }

  disconnectedCallback() {}

  adoptedCallback() {}

  attributeChangedCallback(_name, _oldValue, _newValue) {
    if (this.isConnected) this.#update();
  }

  // ---------------------------------------------------------------------------
  // Hooks for subclasses
  // ---------------------------------------------------------------------------

  /**
   * Returns an array of JS property names to observe.
   * Override in subclass: `static get observedProps() { return ['count']; }`
   *
   * @returns {string[]}
   * @memberof WebComponentCore.BaseComponent
   */
  static get observedProps() {
    return [];
  }

  /**
   * Called when any property listed in `observedProps` changes value.
   * Override in subclass to react to property changes.
   *
   * @param {string} _name
   * @param {*} _oldValue
   * @param {*} _newValue
   * @memberof WebComponentCore.BaseComponent
   */
  propsChangedCallback(_name, _oldValue, _newValue) {}

  /**
   * Returns an HTML string for this component's content.
   * Override in subclass.
   *
   * @returns {string}
   * @memberof WebComponentCore.BaseComponent
   */
  template() {
    return '';
  }

  /**
   * Returns a CSS string to inject into the shadow root once.
   * Override in subclass.
   *
   * @returns {string}
   * @memberof WebComponentCore.BaseComponent
   */
  css() {
    return '';
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Dispatches a composed, bubbling CustomEvent from this element.
   *
   * @param {string} name   - Event name.
   * @param {*}      detail - `event.detail` payload.
   * @memberof WebComponentCore.BaseComponent
   */
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /**
   * Returns the first element matching `selector` within this component's root.
   *
   * @param {string} selector
   * @returns {Element|null}
   * @memberof WebComponentCore.BaseComponent
   */
  query(selector) {
    return this.#root.querySelector(selector);
  }

  /**
   * Returns all elements matching `selector` within this component's root.
   *
   * @param {string} selector
   * @returns {NodeListOf<Element>}
   * @memberof WebComponentCore.BaseComponent
   */
  queryAll(selector) {
    return this.#root.querySelectorAll(selector);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  #injectCss() {
    if (this.#cssInjected) return;
    const styles = this.css();
    if (styles && this.#root instanceof ShadowRoot) {
      const sheet = new CSSStyleSheet();
      // Adoptable stylesheets (Chrome 73+, Firefox 101+, Safari 16.4+).
      // Fall back to a <style> tag for older environments.
      if ('adoptedStyleSheets' in this.#root) {
        sheet.replaceSync(styles);
        this.#root.adoptedStyleSheets = [sheet];
      } else {
        const el = document.createElement('style');
        el.textContent = styles;
        this.#root.prepend(el);
      }
      this.#cssInjected = true;
    }
  }

  #update() {
    const html = this.template();
    if (!html && html !== '') return;
    // innerHTML diff is intentionally simple — use a library (e.g. uhtml,
    // lit-html) for performance-critical high-frequency renders.
    this.#root.innerHTML = html;
    // Re-inject CSS after innerHTML wipe (shadow root content was replaced).
    this.#cssInjected = false;
    this.#injectCss();
  }
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Idempotent `customElements.define` wrapper.
 * Skips registration silently if the tag name is already defined, preventing
 * errors during hot-reload or duplicate imports.
 *
 * @param {string} tagName  - e.g. `'my-card'`
 * @param {typeof BaseComponent} constructor
 * @memberof WebComponentCore
 */
const defineComponent = (tagName, constructor) => {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, constructor);
  }
};

export { BaseComponent, defineComponent };
