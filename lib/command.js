/**
 * The `/image` slash command — caller 1 of two.
 *
 * A thin adapter over `generate()`: it owns only the command grammar (the
 * prompt is the raw input) and the mapping from a thrown error to a
 * `CommandResult`.
 *
 * The registration itself lives in `index.js`, because *when* it can be
 * registered depends on service availability, which is a wiring concern.
 *
 * Note on output: per `@deepseek-ai/dsh-commands`, a command's result text is
 * rendered by the UI and is **not** submitted as a model message, so this is
 * the caller that costs no tokens. The markdown line is what should render the
 * picture inline; the summary above it is the fallback that always reads
 * correctly even where markdown is not rendered.
 *
 * @module @local/dsh-image/lib/command
 */
import { toMessage } from './errors.js';
import { describe, generate } from './generate.js';

/** Command name, as typed after the slash. Lowercase, letters/digits/`_`/`-`. */
export const COMMAND_NAME = 'image';

/**
 * Build the argument for `ctx.commands.register`.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - merged plugin config.
 * @returns {object} a command definition.
 */
export function buildCommand(ctx, config) {
  return {
    name: COMMAND_NAME,
    description: 'Generate an image from a prompt and save it to the workspace',
    // An `input` hint is what makes a host command a `leadingInput` row: DSH
    // opens the composer's input for the argument instead of executing bare.
    input: { hint: '<prompt>' },
    /**
     * @param {object} invocation - `{ rawInput, agent, signal, commandId }`.
     * @returns {Promise<{kind: 'success'|'error', text: string}>}
     */
    async handler(invocation) {
      try {
        const result = await generate(ctx, config, {
          prompt: invocation?.rawInput,
          agent: invocation?.agent,
          signal: invocation?.signal,
        });
        return {
          kind: 'success',
          text: `Saved ${describe(result)}\n\n![${result.prompt}](${result.relPath})`,
        };
      } catch (error) {
        return { kind: 'error', text: toMessage(error) };
      }
    },
  };
}
