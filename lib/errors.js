/**
 * Error type and logging helpers shared by the plugin halves.
 *
 * @module @local/dsh-image/lib/errors
 */

/**
 * A failure whose `message` is written to be shown to the user verbatim:
 * no stack noise, no "undefined", and actionable next steps where we know them.
 *
 * `code` is stable and machine-readable so the two callers (the `/image`
 * command and the `generate_image` tool) can branch on a cause rather than on
 * message text.
 */
export class ImageError extends Error {
  /**
   * @param {string} message - user-facing text.
   * @param {string} [code] - stable identifier, e.g. `NO_KEY`, `TIMEOUT`.
   */
  constructor(message, code = 'IMAGE_ERROR') {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

/**
 * Best-effort diagnostic.
 *
 * Every call site is a path that must not fail: a logger that is missing, or
 * that throws, would otherwise turn a working operation into a broken one. So
 * this swallows its own failures deliberately.
 *
 * Never pass the API key or an `Authorization` header through here.
 *
 * @param {object} ctx - plugin context, possibly without a logger.
 * @param {string} message - what to record.
 */
export function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(`[dsh-image] ${message}`);
  } catch {
    /* logging must never fail the operation */
  }
}

/**
 * Render any thrown value as text safe to put in a command result or tool error.
 *
 * @param {unknown} error - whatever was caught.
 * @returns {string} user-facing text.
 */
export function toMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
