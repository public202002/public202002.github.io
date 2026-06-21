Below is a minimal-but-powerful pattern for a custom element that:

• Exposes a flyweight “model” via a Proxy to detect first-time property access.
• On first access of any property, lazily “installs” the appropriate logic (wires getters/setters, render hooks, observers) so nothing is paid for until it’s touched.
• Propagates property changes to the DOM similarly to a MutationObserver-style reaction, but driven by property traps.
• Keeps the sugar high: you use element.foo = 'bar' and reads like normal properties.

It’s a foundation you can extend with your own on-demand behaviors.

``ts
// Flyweight custom element with lazy-installed reactive properties via Proxy.
//
// Goals:
// - First property access triggers on-the-fly installation (no upfront wiring).
// - Property sets trigger "reactions" (render/update) similar to MutationObserver semantics,
//   but driven by the model's Proxy.
// - Dynamic property discovery: any property you touch begins to exist reactively.
// - Minimal overhead until a property is actually used.

type PropertyInstaller = (el: LazyFlyEl, key: string, initial: unknown) => void;

class LazyFlyEl extends HTMLElement {
  // Backing store for raw values (pre-install).
  #raw = new Map<string | symbol, unknown>();

  // After first access of a key, we "install" its handler here.
  #installed = new Set<string | symbol>();

  // Reactions queue (microtask) to batch updates.
  #pending = new Set<string | symbol>();
  #flushScheduled = false;

  // Hook registry (per-prop) to run when the prop changes.
  #hooks = new Map<string | symbol, Set<(value: unknown, old: unknown) => void>>();

  // Strategy registry to lazily install richer behavior on first access.
  #installers = new Map<string | symbol, PropertyInstaller>();

  // The proxied "model" that users interact with: el.model.foo = 123, etc.
  public model: any;

  constructor() {
    super();

    // Provide a default installer: turns a key into a reactive getter/setter on "model"
    // and syncs an attribute for string/number/boolean values (optional sugar).
    const defaultInstaller: PropertyInstaller = (el, key, initial) => {
      // If you want per-key custom logic, you can register in #installers before access.
      // This default: define a getter/setter on the proxy target itself.
      // Note: We install logic only once, then future gets/sets skip overhead.

      // Initialize value into raw store
      if (!el.#raw.has(key)) el.#raw.set(key, initial);

      // No-op if already installed (defensive)
      if (el.#installed.has(key)) return;

      el.#installed.add(key);

      // Optional: if key is a string, set up attribute reflection as "foo" -> attribute "foo"
      if (typeof key === 'string' && /^[a-zA-Z_]\w*$/.test(key)) {
        el.onChange(key, (v) => {
          // Simple attr reflection heuristic
          if (v === null || v === undefined || v === false) {
            el.removeAttribute(key);
          } else if (v === true) {
            el.setAttribute(key, '');
          } else {
            el.setAttribute(key, String(v));
          }
          // Trigger a (batched) render/update
          el.#enqueueReaction(key);
        });
      } else {
        // For symbol or odd keys, still enqueue reactions on change
        el.onChange(key, () => el.#enqueueReaction(key));
      }
    };

    // A vanilla object acts as the Proxy target; we don't predefine props.
    const target: Record<string | symbol, unknown> = {};

    // The Proxy traps drive first-access installation.
    this.model = new Proxy(target, {
      get: (t, key, receiver) => {
        // Lazy install on first GET
        if (!this.#installed.has(key)) {
          const initial = this.#raw.has(key) ? this.#raw.get(key) : undefined;
          const installer = this.#installers.get(key) ?? defaultInstaller;
          installer(this, String(key), initial);
        }
        // Serve current value
        return this.#raw.get(key);
      },

      set: (t, key, value, receiver) => {
        // If not installed yet, install on first SET
        if (!this.#installed.has(key)) {
          const installer = this.#installers.get(key) ?? defaultInstaller;
          installer(this, String(key), value);
        }
        const old = this.#raw.get(key);
        // Naive change check (can be customized)
        const changed = old !== value && !(Number.isNaN(old) && Number.isNaN(value as any));
        if (changed) {
          this.#raw.set(key, value);
          this.#emitChange(key, value, old);
        }
        return true;
      },

      has: (t, key) => this.#raw.has(key),

      deleteProperty: (t, key) => {
        const existed = this.#raw.has(key);
        if (existed) {
          const old = this.#raw.get(key);
          this.#raw.delete(key);
          this.#emitChange(key, undefined, old);
        }
        return existed;
      },

      ownKeys: (t) => Array.from(this.#raw.keys()) as (string | symbol)[],
      getOwnPropertyDescriptor: (t, key) => {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: this.#raw.get(key),
        };
      },
    });

    // Optionally pre-register sophisticated installers for specific keys
    // Example: "items" becomes an array with auto-render on push/splice without reassign
    this.#installers.set('items', (el, key, initial) => {
      let arr = Array.isArray(initial) ? initial.slice() : (initial == null ? [] : [initial]);

      // Wrap array mutators to emit change without requiring reassignment
      const proxiedArray = new Proxy(arr, {
        get(target, p, r) {
          const v = Reflect.get(target, p, r);
          if (typeof v === 'function' && ['push','pop','shift','unshift','splice','sort','reverse'].includes(String(p))) {
            return (...args: any[]) => {
              const old = target.slice();
              const res = (v as Function).apply(target, args);
              el.#raw.set(key, target);
              el.#emitChange(key, target, old); // change event per mutator
              return res;
            };
          }
          return v;
        }
      });

      el.#raw.set(key, proxiedArray);
      el.#installed.add(key);

      el.onChange(key, () => el.#enqueueReaction(key));
    });
  }

  // Public: subscribe to property changes
  onChange(key: string | symbol, fn: (value: unknown, old: unknown) => void) {
    let set = this.#hooks.get(key);
    if (!set) {
      set = new Set();
      this.#hooks.set(key, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  // Public: register a custom installer before first access
  defineInstaller(key: string | symbol, installer: PropertyInstaller) {
    if (this.#installed.has(key)) {
      throw new Error(Installer for "${String(key)}" must be defined before first access.);
    }
    this.#installers.set(key, installer);
  }

  connectedCallback() {
    // Example sugar: initial render once connected
    this.#render();
  }

  // Batch changes into a microtask to avoid thrashing
  #enqueueReaction(key: string | symbol) {
    this.#pending.add(key);
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      queueMicrotask(() => {
        this.#flushScheduled = false;
        const changed = Array.from(this.#pending);
        this.#pending.clear();
        this.#render(changed);
      });
    }
  }

  // Emit change to hooks
  #emitChange(key: string | symbol, next: unknown, prev: unknown) {
    const set = this.#hooks.get(key);
    if (set && set.size) {
      for (const fn of set) {
        try { fn(next, prev); } catch (e) { console.error(e); }
      }
    } else {
      // No listeners? Still schedule a render to keep DOM in sync.
      this.#enqueueReaction(key);
    }
  }

  // Render: update DOM from current state.
  // You can make this smarter (template, keyed updates, etc.).
  #render(changedKeys?: (string | symbol)[]) {
    // Simple demo: reflect a JSON snapshot and specific sugar if present.
    // Prefer incremental updates using changedKeys if you maintain a template.
    const title = typeof this.model.title === 'string' ? this.model.title : '';
    const count = typeof this.model.count === 'number' ? this.model.count : undefined;

    this.innerHTML = 
      <div class="host">
        ${title ? <h3>${escapeHTML(title)}</h3> : ''}
        ${count !== undefined ? <p>Count: ${count}</p> : ''}
        <pre>${escapeHTML(JSON.stringify(snapshot(this.#raw), null, 2))}</pre>
      </div>
    ;
  }
}

// Utilities
function snapshot(map: Map<any, any>) {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of map) obj[String(k)] = v;
  return obj;
}

function escapeHTML(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]!));
}

customElements.define('lazy-fly-el', LazyFlyEl);

// ---- Example usage (in page code) ----
// <lazy-fly-el id="x"></lazy-fly-el>
//
// const x = document.getElementById('x') as any as LazyFlyEl;
// // No upfront cost; first touches install on demand:
// x.model.title = 'Hello Flyweight';
// x.model.count = 1;
// x.model.items = [1, 2];
// x.model.items.push(3); // triggers render without reassigning
//
// // Add custom behavior for a future key:
// x.defineInstaller('status', (el, key, initial) => {
//   let val = initial ?? 'idle';
//   el.onChange(key, (v) => {
//     el.toggleAttribute('data-busy', v === 'busy');
//     el.#enqueueReaction(key as any); // not accessible; instead emit via set:
//   });
//   el.model[key as any] = val; // triggers default flow and hooks
// });
``

How it works

• Proxy as the flyweight boundary:
  - On first get/set of any key, we look up a per-key installer (if any) or a default reactive installer and apply it.
  - After install, the property is managed via a simple Map store; future accesses are cheap.

• On-the-fly installation:
  - The installer can attach hooks, attribute reflection, array mutator wrapping, or any domain-specific code.
  - Different keys can have different behaviors. Nothing is created until the property is accessed.

• Property change propagation:
  - Sets trigger #emitChange, which notifies per-key hooks.
  - A microtask batches changes and calls #render once per tick, similar to MutationObserver’s async nature but property-driven.

• Sugar:
  - Attribute reflection for string/number/boolean-like props.
  - Special “items” installer that wraps array mutators so pushes/splices emit change automatically.

Notes and extensions

• If you want attribute-to-prop sync too, implement static get observedAttributes() and attributeChangedCallback to write into model[prop].
• For templating, swap #render for a real template engine or a keyed DOM patcher; keep the same batched schedule.
• For debugging, instrument the Proxy traps and installers to log first access vs subsequent accesses.
• For strict typing, replace any with a generic interface parameter for the model and declare known keys.

This gives you a compact flyweight object model with maximum sugar and zero-cost until a property is actually used.
