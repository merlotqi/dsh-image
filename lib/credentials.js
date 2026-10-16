/**
 * API-key resolution.
 *
 * The plugin config carries only the *name* of a credential (`apiKeyRef`); the
 * value is fetched from DSH's credential service on every operation. That
 * service already layers, highest priority first:
 *
 *   the environment DSH was launched with
 *     → ~/.dsh/.credentials.yaml
 *       → <project>/.env
 *         → $DSH_HOME/.env
 *
 * Resolving per operation — rather than caching at activation — is what lets a
 * rotated key take effect without a plugin restart; the store reloads the file
 * on change and `resolve()` is read fresh each time.
 *
 * @module @local/dsh-image/lib/credentials
 */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { lookup } from './context.js';
import { ImageError } from './errors.js';

/**
 * Resolve the relay API key.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - merged plugin config.
 * @returns {Promise<{value: string, source: string}>} the key and where it came from.
 * @throws {ImageError} `BAD_REF` for a malformed reference, `NO_KEY` when unset.
 */
export async function resolveApiKey(ctx, config) {
  const refName = String(config.apiKeyRef ?? '').trim();

  // Fail on a malformed *name* before doing any work: a name that cannot exist
  // in the store should read as a configuration mistake, not as a missing key.
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
    // The store treats an empty stored value as absent everywhere, so a blank
    // never masquerades as a configured secret. Match that here.
    if (found && typeof found.value === 'string' && found.value.trim() !== '') {
      return { value: found.value.trim(), source: found.source ?? 'store' };
    }
  }

  // Defensive fallback for a profile without the credential service. The store
  // already layers the launching environment, so this only ever adds coverage.
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
