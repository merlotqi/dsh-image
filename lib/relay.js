/**
 * Minimal client for an OpenAI-compatible image relay.
 *
 * The *request* matches OpenAI's `POST /v1/images/generations`. The *response*
 * shape is deliberately not assumed, because relays in the wild differ. Three
 * shapes are handled, and the caller is told which one it got so a first run
 * resolves the question instead of us having to guess:
 *
 *   1. raw image bytes with an `image/*` content type,
 *   2. JSON carrying `data[0].b64_json` (what OpenAI itself returns for the
 *      gpt-image family),
 *   3. JSON carrying `data[0].url`, which is then downloaded.
 *
 * This module holds no state and reads no config: everything arrives as
 * arguments, which is what makes it directly testable (see `test/relay.test.mjs`).
 *
 * @module @local/dsh-image/lib/relay
 */

/** Image container → file extension, for the cases a relay names its type. */
export const EXT_BY_CONTENT_TYPE = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
});

/** How many bytes of a body an error message may quote. */
const SNIPPET_LIMIT = 300;

/** Failure from the relay layer, before it is wrapped as an `ImageError`. */
export class RelayError extends Error {
  /**
   * @param {string} message - human-readable failure, safe to show the user.
   * @param {string} code - stable machine-readable code.
   * @param {number} [status] - HTTP status when the failure was a response.
   */
  constructor(message, code = 'RELAY_ERROR', status) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Join a base URL and a path without doubling or dropping the slash. */
function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}/${String(suffix).replace(/^\/+/, '')}`;
}

/** A short, single-line excerpt of a body, for error messages. */
function snippet(buf, limit = SNIPPET_LIMIT) {
  const text = buf.subarray(0, limit * 4).toString('utf8').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Whether a body should be parsed as JSON, by declared type or by first byte. */
function looksLikeJson(contentType, buf) {
  if (contentType.includes('json')) return true;
  const head = buf.subarray(0, 1).toString('utf8');
  return head === '{' || head === '[';
}

/**
 * Ask the relay for one image.
 *
 * @param {object} options - request inputs.
 * @param {string} options.baseUrl - relay base, e.g. `https://api.ykh.ai/v1`.
 * @param {string} options.model - model id, e.g. `gpt-image-2`.
 * @param {string} options.apiKey - bearer token; never logged by this module.
 * @param {string} options.prompt - the user's prompt.
 * @param {string} [options.size] - size such as `1024x1024`.
 * @param {AbortSignal} [options.signal] - cancellation and/or timeout.
 * @returns {Promise<{bytes: Buffer, contentType: string, ext: string, shape: string}>}
 *   the image bytes plus which branch produced them.
 * @throws {RelayError} for every failure that is not a caller abort.
 */
export async function requestImage({ baseUrl, model, apiKey, prompt, size, signal }) {
  const url = joinUrl(baseUrl, 'images/generations');

  // Deliberately the same body the known-good curl sends — `model`, `prompt`,
  // and `size` only. Adding OpenAI's optional `n` would be unnecessary risk
  // against a relay that may validate parameters more strictly than advertised.
  const body = { model, prompt };
  if (size) body.size = size;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, image/*',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // An abort is the caller's business (cancellation or timeout); rethrow it
    // untouched so `generate()` can tell the two apart.
    if (error?.name === 'AbortError') throw error;
    throw new RelayError(`Could not reach ${url}: ${error?.message ?? String(error)}`, 'NETWORK');
  }

  const rawType = response.headers.get('content-type') ?? '';
  const contentType = rawType.split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    const detail = buf.length > 0 ? `: ${snippet(buf)}` : '';
    throw new RelayError(
      `Relay returned HTTP ${response.status}${statusText}${detail}`,
      `HTTP_${response.status}`,
      response.status,
    );
  }
  if (buf.length === 0) throw new RelayError('Relay returned an empty body.', 'EMPTY_BODY');

  // 1) Raw image bytes.
  if (contentType.startsWith('image/')) {
    return {
      bytes: buf,
      contentType,
      ext: EXT_BY_CONTENT_TYPE[contentType] ?? '.png',
      shape: 'binary',
    };
  }

  // 2) JSON envelope.
  if (looksLikeJson(contentType, buf)) {
    let payload;
    try {
      payload = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new RelayError(`Relay returned unparsable JSON: ${snippet(buf)}`, 'BAD_JSON');
    }

    const item = Array.isArray(payload?.data) ? payload.data[0] : undefined;
    if (!item || typeof item !== 'object') {
      throw new RelayError(`Relay JSON had no usable data[0]: ${snippet(buf)}`, 'NO_DATA');
    }

    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      // Tolerate a full `data:image/png;base64,…` URL as well as bare base64.
      const comma = item.b64_json.indexOf(',');
      const base64 = item.b64_json.startsWith('data:') && comma !== -1
        ? item.b64_json.slice(comma + 1)
        : item.b64_json;
      return {
        bytes: Buffer.from(base64, 'base64'),
        contentType: 'image/png',
        ext: '.png',
        shape: 'b64_json',
      };
    }

    if (typeof item.url === 'string' && item.url.length > 0) {
      let downloaded;
      try {
        downloaded = await fetch(item.url, { signal });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new RelayError(
          `Could not download ${item.url}: ${error?.message ?? String(error)}`,
          'DOWNLOAD',
        );
      }
      if (!downloaded.ok) {
        throw new RelayError(`Could not download ${item.url}: HTTP ${downloaded.status}`, 'DOWNLOAD');
      }
      const type = (downloaded.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      return {
        bytes: Buffer.from(await downloaded.arrayBuffer()),
        contentType: type || 'image/png',
        ext: EXT_BY_CONTENT_TYPE[type] ?? '.png',
        shape: 'url',
      };
    }

    throw new RelayError(`Relay JSON had neither b64_json nor url: ${snippet(buf)}`, 'NO_IMAGE');
  }

  // 3) Something we do not recognise — report it precisely rather than guess.
  throw new RelayError(
    `Unrecognised response (content-type "${rawType || 'none'}"): ${snippet(buf)}`,
    'UNKNOWN_SHAPE',
  );
}
