/**
 * Plugin configuration.
 *
 * `DEFAULTS` is the single source of truth for every tunable, and it exists in
 * two shapes on purpose:
 *
 *   - `Config` (in `index.js`) declares it as a schemastery schema, which is
 *     what DSH validates a profile row against and what lets users override
 *     values in their own `cordis.patch.yml`.
 *   - `resolveConfig()` re-applies the same values in code.
 *
 * The second copy is not redundant. A row that omits `config:` entirely — or a
 * loader that validates without filling defaults — would otherwise hand `apply`
 * an object missing every field, and we would send the literal string
 * "undefined" to the relay as the model name.
 *
 * @module @local/dsh-image/lib/config
 */

/** Every tunable, with its default. Frozen so nothing can mutate it in place. */
export const DEFAULTS = Object.freeze({
  /**
   * Relay base URL, **without** the trailing path. `/images/generations` is
   * appended. Any OpenAI-compatible relay works; keep this in config rather
   * than in code so switching relays is a config edit.
   */
  baseUrl: 'https://api.ykh.ai/v1',

  /** Model id sent to the relay. */
  model: 'gpt-image-2',

  /**
   * Name of the credential reference holding the API key — a *name*, never the
   * key itself. Resolved per operation through DSH's credential service.
   */
  apiKeyRef: 'YKH_API_KEY',

  /** Applied when a call does not pass an explicit `size`. */
  defaultSize: '1024x1024',

  /** Ceiling for one relay round-trip. Image generation is slow but not this slow. */
  requestTimeoutMs: 180000,

  /**
   * Subdirectory of the session workspace that images are written into.
   * Deliberately a plain, neutral name: the plugin must not depend on the
   * session workspace being anything in particular.
   */
  outputDir: 'images',
});

/**
 * Merge a row's `config` over the defaults.
 *
 * @param {object} [raw] - the row's `config`, possibly absent or partial.
 * @returns {object} a complete config object.
 */
export function resolveConfig(raw) {
  return { ...DEFAULTS, ...(raw ?? {}) };
}
