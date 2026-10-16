/**
 * Cordis context helpers.
 *
 * @module @local/dsh-image/lib/context
 */

/**
 * Read a service from a context without requiring the context to expose `get`.
 *
 * Two reasons this is not just `ctx[name]`:
 *
 *   1. Cordis marks a *missing* service through `ctx.get(name)`; the property
 *      may be absent entirely. Asking with `strict = false` returns `undefined`
 *      instead of throwing, which is what an optional service needs.
 *   2. A plugin context can be a proxy whose property read throws for services
 *      it does not expose. The property read is therefore the fallback, not the
 *      first choice.
 *
 * @param {object} context - a cordis context (plugin root, or `agent.ctx`).
 * @param {string} serviceName - e.g. `commands`, `tools`, `credentials`.
 * @returns {any} the service, or `undefined` when it is not available.
 */
export function lookup(context, serviceName) {
  try {
    if (context && typeof context.get === 'function') {
      const found = context.get(serviceName, false);
      if (found) return found;
    }
  } catch {
    /* fall through to the property read */
  }
  try {
    return context?.[serviceName];
  } catch {
    return undefined;
  }
}
