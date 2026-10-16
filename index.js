/**
 * dsh-image — image generation for DeepSeek Harness through a relay.
 *
 * One operation, two callers (DSH's own guidance for "user actions and agent
 * tools"): the `/image` slash command and the `generate_image` agent tool both
 * call `generate()` below. There is deliberately no second copy of the logic.
 *
 * ---------------------------------------------------------------------------
 * LOADING NOTES — two traps this plugin hit, both silent:
 *
 * 1. `main`. Every working bundle in this profile (`dsh-context`, `dshmarket`,
 *    `@dsh-pet/bridge`) declares a top-level `main`. The host reads package
 *    manifests itself (`readPackageManifest`) rather than relying on Node's
 *    `exports` resolution, so a package carrying only `exports` never resolves
 *    to an entry and the plugin is never applied. `package.json` sets `main`.
 *
 * 2. Injection. `@deepseek-ai/dsh-base/cordis.patch.yml` states the rule:
 *    "Row order carries no load semantics (activation is service-availability
 *    driven)". A bundle row whose declared `inject` can never be satisfied is
 *    simply never applied — it is not a skipped bundle, not a "broken" plugin,
 *    and nothing is logged. `tools` is AGENT-scoped (every shipped tool row is
 *    nested in the agent preset's group; the root `tool-plugin-manager` row is
 *    hard-`disabled: true`), so declaring it here could never succeed. We now
 *    declare NO injection at all and fetch what we need through
 *    `ctx.inject([...])`, which cannot hold the plugin back.
 * ---------------------------------------------------------------------------
 *
 * The API key is never stored in this plugin's config. The config carries only
 * the *name* of a credential reference; the value is resolved per operation
 * through DSH's credential service, which itself layers:
 *   launching environment  →  ~/.dsh/.credentials.yaml  →  project/.env  →  home/.env
 *
 * @module @local/dsh-image
 */
import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { requestImage, RelayError } from './lib/relay.js';

/** Stable Loader identity. */
export const name = 'dsh-image';

/**
 * Deliberately empty.
 *
 * There is no service this plugin cannot work without: the command is
 * registered when its registry appears (`ctx.inject` below) and the tool is
 * registered per agent (`agent/created`). Declaring anything here would let a
 * missing service silently keep the entire plugin unapplied.
 */
export const inject = [];

/** Tunables, so users change them in `cordis.patch.yml` rather than in code. */
export const Config = z.object({
  baseUrl: z.string().default('https://api.ykh.ai/v1'),
  model: z.string().default('gpt-image-2'),
  apiKeyRef: z.string().default('YKH_API_KEY'),
  defaultSize: z.string().default('1024x1024'),
  requestTimeoutMs: z.number().default(180000),
  outputDir: z.string().default('dsh-image'),
});

/**
 * The same values again, applied in code.
 *
 * The loader validates a row against `Config` and fills the defaults in, so
 * these are normally redundant. They exist because a row that omits `config:`
 * entirely — or a loader that validates without defaulting — would otherwise
 * hand `apply` an object missing every field, and we would send the literal
 * string "undefined" to the relay as the model name.
 */
const DEFAULTS = {
  baseUrl: 'https://api.ykh.ai/v1',
  model: 'gpt-image-2',
  apiKeyRef: 'YKH_API_KEY',
  defaultSize: '1024x1024',
  requestTimeoutMs: 180000,
  outputDir: 'dsh-image',
};

/** Failure carrying a message that is safe to show the user verbatim. */
class ImageError extends Error {
  constructor(message, code = 'IMAGE_ERROR') {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

/** Best-effort diagnostic that can never break a registration path. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`[dsh-image] ${message}`);
  } catch {
    /* logging must never fail the operation */
  }
}

/** Read a service from a context without requiring it to expose `get`. */
function lookup(context, serviceName) {
  try {
    if (context && typeof context.get === 'function') {
      const found = context.get(serviceName, false);
      if (found) return found;
    }
  } catch {
    /* fall through to the property read */
  }
  return context?.[serviceName];
}

/**
 * Resolve the relay API key.
 *
 * The credential store is the primary source (it already layers the launching
 * environment and `.env` files), with a direct `process.env` read as a
 * defensive fallback for profiles without the service.
 *
 * Resolved per operation, on purpose: DSH's credential service reloads changed
 * values live, so rotating the key never needs a plugin restart.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - merged plugin config.
 * @returns {Promise<{value: string, source: string}>}
 * @throws {ImageError} when no key is configured, with instructions.
 */
async function resolveApiKey(ctx, config) {
  const refName = String(config.apiKeyRef ?? '').trim();
  if (!isCredentialRefName(refName)) {
    throw new ImageError(
      `apiKeyRef ${JSON.stringify(refName)} is not a valid credential reference. ` +
        'Use a shell-style name such as YKH_API_KEY.',
      'BAD_REF',
    );
  }

  const credentials = lookup(ctx, 'credentials');
  if (credentials && typeof credentials.resolve === 'function') {
    const found = await credentials.resolve(credentialRef(refName));
    if (found && typeof found.value === 'string' && found.value.trim() !== '') {
      return { value: found.value.trim(), source: found.source ?? 'store' };
    }
  }

  const fromEnv = process.env[refName];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { value: fromEnv.trim(), source: 'process-env' };
  }

  throw new ImageError(
    `No API key found for "${refName}". Set it either way:\n` +
      '  • add it to ~/.dsh/.credentials.yaml (the store reloads automatically):\n' +
      `      refs:\n        ${refName}: <your-key>\n` +
      `  • or export ${refName}=<your-key> before launching DSH`,
    'NO_KEY',
  );
}

/** Filesystem-safe, human-recognisable name derived from the prompt. */
function slugify(text, max = 40) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return slug || 'image';
}

/** `YYYYMMDD-HHMMSS`, local time, so files sort chronologically. */
function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Combine the caller's signal with a timeout, tolerating missing primitives. */
function combineSignals(signals) {
  const list = signals.filter((s) => s instanceof AbortSignal);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return typeof AbortSignal.any === 'function' ? AbortSignal.any(list) : list[0];
}

/**
 * The single operation behind both callers: resolve the key, ask the relay,
 * write the bytes into the workspace, and report where they landed.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - merged plugin config.
 * @param {object} request - call inputs.
 * @param {string} request.prompt - what to draw.
 * @param {string} [request.size] - override size.
 * @param {object} [request.agent] - receiving agent, for the workspace cwd.
 * @param {AbortSignal} [request.signal] - cancellation.
 * @returns {Promise<object>} saved-file details.
 */
async function generate(ctx, config, { prompt, size, agent, signal }) {
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
      throw new ImageError(
        signal?.aborted ? 'Cancelled.' : `Relay did not answer within ${config.requestTimeoutMs} ms.`,
        'TIMEOUT',
      );
    }
    if (error instanceof RelayError) throw new ImageError(error.message, error.code);
    throw error;
  }

  // Where the image lands. `agent.session.header.cwd` is the session workspace:
  // the same root `present` resolves relative paths against, and therefore the
  // root a markdown image reference has to be relative to.
  const cwd = agent?.session?.header?.cwd ?? process.env.DSH_WORKSPACE;
  if (!cwd) {
    throw new ImageError(
      'Cannot determine a workspace to write into: this call carried no agent session cwd. ' +
        'Run /image from a session with a workspace, or set outputDir to an absolute path.',
      'NO_WORKSPACE',
    );
  }

  const root = path.resolve(cwd, config.outputDir);
  fs.mkdirSync(root, { recursive: true });

  const file = path.join(root, `${timestamp()}-${slugify(text)}${image.ext}`);
  fs.writeFileSync(file, image.bytes);

  // Forward-slashed and workspace-relative: an absolute Windows path inside a
  // markdown image reference is both an escape hazard (backslashes) and
  // unresolvable for the transcript's loader, which resolves against the
  // session workspace rather than the filesystem root.
  const relPath = path.relative(cwd, file).split(path.sep).join('/');

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

  // Never log the key or the bearer token. The model, size, response shape and
  // byte count are what make the first real run diagnosable.
  try {
    ctx.logger?.info?.(
      `[dsh-image] saved ${relPath} (${result.model}, ${result.size}, ` +
        `${result.shape}, ${result.bytes} bytes, key via ${keySource})`,
    );
  } catch {
    /* logging must never fail the operation */
  }

  return result;
}

/** One-line summary of a saved image, shared by both callers. */
function describe(result) {
  return (
    `${result.relPath} (${result.model}, ${result.size}, ` +
    `${Math.round(result.bytes / 1024)} KiB, ${result.shape}, key via ${result.keySource})`
  );
}

/**
 * The `/image` command definition. A factory so registration cannot drift.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - merged plugin config.
 * @returns {object} the `ctx.commands.register` argument.
 */
function buildCommand(ctx, config) {
  return {
    name: 'image',
    description: 'Generate an image from a prompt and save it to the workspace',
    input: { hint: '<prompt>' },
    async handler(invocation) {
      try {
        const result = await generate(ctx, config, {
          prompt: invocation?.rawInput,
          agent: invocation?.agent,
          signal: invocation?.signal,
        });
        // Command output is UI-side and never enters model history, so the
        // markdown line is what should render the picture inline; the plain
        // summary is the fallback that always reads correctly.
        return {
          kind: 'success',
          text: `Saved ${describe(result)}\n\n![${result.prompt}](${result.relPath})`,
        };
      } catch (error) {
        return {
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * The `generate_image` tool definition. A factory so the per-agent
 * registration cannot drift from any future caller.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - merged plugin config.
 * @returns {object} the `defineTool` definition.
 */
function buildTool(ctx, config) {
  return defineTool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt and save it into the workspace. ' +
      'Returns `path` (absolute) and `relPath` (relative to the session workspace). ' +
      'Show the result by embedding relPath as a markdown image — ![description](relPath) — ' +
      'or by passing the absolute path to present.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw. Concrete, specific descriptions work best.',
      },
      size: {
        type: 'string',
        description: `Image size such as 1024x1024 or 1536x1024. Defaults to ${config.defaultSize}.`,
      },
    },
    async execute(args, exec) {
      const result = await generate(ctx, config, {
        prompt: args?.prompt,
        size: args?.size,
        agent: exec?.agent,
        signal: exec?.signal,
      });
      return {
        path: result.path,
        relPath: result.relPath,
        bytes: result.bytes,
        model: result.model,
        size: result.size,
        shape: result.shape,
      };
    },
  });
}

/**
 * Register the slash command (root scope) and the agent tool (per agent).
 *
 * @param {object} ctx - plugin context.
 * @param {object} [rawConfig] - the row's `config`; defaults are re-applied below.
 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  warn(ctx, `applied (baseUrl=${config.baseUrl}, model=${config.model}, ref=${config.apiKeyRef})`);

  // ---- caller 1: the `/image` slash command (root-scoped registry) -------
  // Fetched via `ctx.inject` rather than declared in `inject`, so a missing
  // command registry can never keep the whole plugin unapplied.
  ctx.inject(['commands'], (scope) => {
    try {
      const commands = lookup(scope, 'commands');
      if (!commands || typeof commands.register !== 'function') {
        warn(ctx, 'no `commands` registry in scope; /image not registered');
        return;
      }
      scope.effect(() => commands.register(buildCommand(ctx, config)), 'dsh-image command');
    } catch (error) {
      warn(ctx, `command registration failed: ${error?.message ?? error}`);
    }
  });

  // ---- caller 2: the `generate_image` tool, ONE PER AGENT ----------------
  // `tools` lives in the agent scope, so this cannot be done at the root: the
  // agent context is the only place that registry exists. Registering inside a
  // single `agent.ctx.effect()` also ties disposal to the agent automatically.
  ctx.on('agent/created', ({ agent }) => {
    try {
      const agentCtx = agent?.ctx;
      if (!agentCtx || typeof agentCtx.effect !== 'function') {
        warn(ctx, 'agent/created carried no agent ctx; tool not registered');
        return;
      }

      const tools = lookup(agentCtx, 'tools');
      if (!tools || typeof tools.register !== 'function') {
        warn(ctx, 'no `tools` registry on the agent context; tool not registered');
        return;
      }

      agentCtx.effect(() => tools.register(buildTool(ctx, config)), 'dsh-image tool');
    } catch (error) {
      // Never let the tool half take down the command half.
      warn(ctx, `tool registration failed: ${error?.message ?? error}`);
    }
  });
}
