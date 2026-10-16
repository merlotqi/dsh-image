/**
 * The single operation behind both callers.
 *
 * DSH's own guidance for "user actions and agent tools" is explicit: implement
 * the operation once as a host method, then let the UI action and the agent
 * tool both call it — *"Do not maintain separate operation logic in the UI and
 * tool paths."* That is what this module is: `generate()` is the only place
 * that talks to the relay, and `buildCommand` / `buildTool` are thin adapters
 * over it.
 *
 * @module @local/dsh-image/lib/generate
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveApiKey } from './credentials.js';
import { ImageError } from './errors.js';
import { RelayError, requestImage } from './relay.js';

/** Longest slug taken from a prompt, before the extension. */
const SLUG_MAX = 40;

/**
 * Filesystem-safe, human-recognisable name derived from the prompt.
 *
 * Prompts are prose in any language; this keeps the ASCII words and drops the
 * rest, so a file stays readable and sortable even when the prompt was not.
 *
 * @param {string} text - the prompt.
 * @param {number} [max] - maximum length.
 * @returns {string} a non-empty slug.
 */
export function slugify(text, max = SLUG_MAX) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return slug || 'image';
}

/**
 * `YYYYMMDD-HHMMSS` in local time, so files sort chronologically by name.
 *
 * @param {Date} [date] - the instant to render.
 * @returns {string} the stamp.
 */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Combine the caller's abort signal with a timeout.
 *
 * `AbortSignal.any` is not guaranteed on every host runtime, so a missing one
 * degrades to the caller's own signal rather than throwing.
 *
 * @param {Array<AbortSignal|undefined>} signals - candidates.
 * @returns {AbortSignal|undefined} one signal covering all inputs.
 */
function combineSignals(signals) {
  const list = signals.filter((s) => s instanceof AbortSignal);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return typeof AbortSignal.any === 'function' ? AbortSignal.any(list) : list[0];
}

/**
 * Resolve the destination directory and write the image.
 *
 * @param {object} request - write inputs.
 * @param {string} request.cwd - session workspace root.
 * @param {string} request.outputDir - subdirectory, relative or absolute.
 * @param {string} request.prompt - used for the filename.
 * @param {{bytes: Buffer, ext: string}} request.image - what to write.
 * @returns {{path: string, relPath: string}} absolute and workspace-relative paths.
 */
function writeImage({ cwd, outputDir, prompt, image }) {
  const root = path.resolve(cwd, outputDir);
  fs.mkdirSync(root, { recursive: true });

  const file = path.join(root, `${timestamp()}-${slugify(prompt)}${image.ext}`);
  fs.writeFileSync(file, image.bytes);

  // Forward-slashed and workspace-relative: an absolute Windows path inside a
  // markdown image reference is both an escape hazard (backslashes) and
  // unresolvable for the transcript's loader, which resolves against the
  // session workspace rather than the filesystem root.
  const relPath = path.relative(cwd, file).split(path.sep).join('/');
  return { path: file, relPath };
}

/**
 * Generate one image and save it into the workspace.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - merged plugin config.
 * @param {object} request - call inputs.
 * @param {string} request.prompt - what to draw.
 * @param {string} [request.size] - override `config.defaultSize`.
 * @param {object} [request.agent] - receiving agent, for the workspace cwd.
 * @param {AbortSignal} [request.signal] - cancellation.
 * @returns {Promise<object>} saved-file details, including `path` and `relPath`.
 * @throws {ImageError} with a message safe to show the user.
 */
export async function generate(ctx, config, { prompt, size, agent, signal }) {
  const text = String(prompt ?? '').trim();
  if (text === '') {
    throw new ImageError(
      'A prompt is required, e.g. /image a blue ceramic cup on a white background',
      'NO_PROMPT',
    );
  }

  const { value: apiKey, source: keySource } = await resolveApiKey(ctx, config);
  const effectiveSize = size ? String(size) : String(config.defaultSize);

  const timeout = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(config.requestTimeoutMs)
    : undefined;
  const combined = combineSignals([signal, timeout]);

  let image;
  try {
    image = await requestImage({
      baseUrl: String(config.baseUrl),
      model: String(config.model),
      apiKey,
      prompt: text,
      size: effectiveSize,
      signal: combined,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      // Distinguish "the user cancelled" from "the relay was too slow": the
      // caller's signal is the only thing that can tell them apart.
      throw new ImageError(
        signal?.aborted ? 'Cancelled.' : `Relay did not answer within ${config.requestTimeoutMs} ms.`,
        'TIMEOUT',
      );
    }
    if (error instanceof RelayError) throw new ImageError(error.message, error.code);
    throw error;
  }

  // `agent.session.header.cwd` is the session workspace: the same root that
  // `present` resolves relative paths against, and therefore the root a
  // markdown image reference has to be relative to.
  const cwd = agent?.session?.header?.cwd ?? process.env.DSH_WORKSPACE;
  if (!cwd) {
    throw new ImageError(
      'Cannot determine a workspace to write into: this call carried no agent session cwd. ' +
        'Run /image from a session with a workspace, or set outputDir to an absolute path.',
      'NO_WORKSPACE',
    );
  }

  const { path: file, relPath } = writeImage({
    cwd,
    outputDir: String(config.outputDir),
    prompt: text,
    image,
  });

  const result = {
    path: file,
    relPath,
    bytes: image.bytes.length,
    model: String(config.model),
    size: effectiveSize,
    shape: image.shape,
    contentType: image.contentType,
    keySource,
    prompt: text,
  };

  // Never log the key or the bearer token. Model, size, response shape and byte
  // count are what make a first real run diagnosable.
  try {
    ctx?.logger?.info?.(
      `[dsh-image] saved ${relPath} (${result.model}, ${result.size}, ` +
        `${result.shape}, ${result.bytes} bytes, key via ${keySource})`,
    );
  } catch {
    /* logging must never fail the operation */
  }

  return result;
}

/**
 * One-line summary of a saved image, shared by both callers.
 *
 * @param {object} result - the object `generate()` returned.
 * @returns {string} human-readable summary.
 */
export function describe(result) {
  return (
    `${result.relPath} (${result.model}, ${result.size}, ` +
    `${Math.round(result.bytes / 1024)} KiB, ${result.shape}, key via ${result.keySource})`
  );
}
