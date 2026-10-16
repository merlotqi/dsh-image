/**
 * dsh-image — image generation for DeepSeek Harness through a relay.
 *
 * This file is **wiring only**: identity, config schema, and how the two
 * callers get registered. Behaviour lives in `lib/`:
 *
 *   lib/generate.js     the single operation both callers use
 *   lib/command.js      the `/image` slash-command adapter
 *   lib/tool.js         the `generate_image` agent-tool adapter
 *   lib/relay.js        HTTP client (three response shapes)
 *   lib/credentials.js  API-key resolution through DSH's credential store
 *   lib/config.js       defaults, and the config merge
 *   lib/context.js      service lookup helper
 *   lib/errors.js       error type and logging
 *
 * ---------------------------------------------------------------------------
 * LOADING NOTES — three traps this plugin hit, all of them silent. They are
 * recorded here because each cost real debugging time and none of them
 * produces a diagnostic:
 *
 * 1. **Install as a real package, not a symlink.** A `link:`ed bundle resolves
 *    its imports from the link target's *real* path. If that path is outside
 *    the profile (a workspace, say), the host's installation-scope resolver
 *    does not cover it, so any bare `@deepseek-ai/*` import fails and the entry
 *    is dropped with the message "failed to import" — a bare literal the loader
 *    emits when no fiber could be created. Install with `file:`:
 *
 *        dsh plugin --profile <p> add file:/abs/path/to/dsh-image
 *
 *    (The zero-dependency bridge plugins that dodge this do so by importing
 *    nothing but `node:*` builtins.)
 *
 * 2. **`main` matters.** The host reads package manifests itself rather than
 *    going through Node's `exports` resolution, so an `exports`-only manifest
 *    can fail to resolve an entry even though the file exists. `package.json`
 *    therefore declares `main` as well.
 *
 * 3. **Injection is a load barrier, and it fails closed and silent.**
 *    `@deepseek-ai/dsh-base/cordis.patch.yml` states the rule: "Row order
 *    carries no load semantics (activation is service-availability driven)".
 *    A row whose declared `inject` can never be satisfied is simply never
 *    applied — not skipped, not "broken", nothing logged. `tools` is
 *    AGENT-scoped (every shipped tool row is nested in the agent preset's
 *    group; the root `tool-plugin-manager` row is hard-`disabled: true`), so
 *    declaring it here could never succeed. This plugin therefore declares NO
 *    injection and fetches what it needs through `ctx.inject([...])`.
 * ---------------------------------------------------------------------------
 *
 * The API key is never stored in this plugin's config. The config carries only
 * the *name* of a credential reference; the value is resolved per operation
 * through DSH's credential service, which itself layers:
 *   launching environment  →  ~/.dsh/.credentials.yaml  →  project/.env  →  home/.env
 *
 * @module @local/dsh-image
 */
import z from '@deepseek-ai/schemastery';
import { buildCommand } from './lib/command.js';
import { DEFAULTS, resolveConfig } from './lib/config.js';
import { lookup } from './lib/context.js';
import { warn } from './lib/errors.js';
import { buildTool } from './lib/tool.js';

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

/**
 * Config schema. DSH validates a profile row against this and fills the
 * defaults in; `resolveConfig()` applies the same defaults again in code so a
 * row that omits `config:` cannot reach the relay with `undefined` fields.
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULTS.baseUrl),
  model: z.string().default(DEFAULTS.model),
  apiKeyRef: z.string().default(DEFAULTS.apiKeyRef),
  defaultSize: z.string().default(DEFAULTS.defaultSize),
  requestTimeoutMs: z.number().default(DEFAULTS.requestTimeoutMs),
  outputDir: z.string().default(DEFAULTS.outputDir),
});

/**
 * Register both callers.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [rawConfig] - the row's `config`; defaults are re-applied here.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  warn(
    ctx,
    `applied (baseUrl=${config.baseUrl}, model=${config.model}, ` +
      `ref=${config.apiKeyRef}, out=${config.outputDir})`,
  );

  // ---- caller 1: the `/image` slash command (root-scoped registry) --------
  // `commands` is a ROOT-scoped service, but it is still fetched through
  // `ctx.inject` rather than declared in `inject`, so a profile without a
  // command registry cannot keep the whole plugin — tool included — unapplied.
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

  // ---- caller 2: the `generate_image` tool, ONE PER AGENT -----------------
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
