/**
 * The `generate_image` agent tool — caller 2 of two.
 *
 * A thin adapter over `generate()`: it owns only the parameter surface and the
 * shape of the tool result. The registration lives in `index.js`, because
 * `tools` is an **agent-scoped** service: the tool has to be registered on each
 * agent's own context, not on the plugin's root context.
 *
 * @module @local/dsh-image/lib/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { generate } from './generate.js';

/** Tool name, as the model sees it. */
export const TOOL_NAME = 'generate_image';

/**
 * Build the argument for `ctx.tools.register`.
 *
 * @param {object} ctx - plugin context (used by the shared operation).
 * @param {object} config - merged plugin config.
 * @returns {object} a `defineTool` definition.
 */
export function buildTool(ctx, config) {
  return defineTool({
    name: TOOL_NAME,
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
      // Report both paths: `relPath` is what renders in the transcript,
      // `path` is what tools that need a real filesystem path want.
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
