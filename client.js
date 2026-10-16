/**
 * Browser half of dsh-image.
 *
 * The host half already registers `/image`; this half exists only to give that
 * row its own label, description and icon in the composer's `/` menu, which is
 * client-owned metadata.
 *
 * Two deliberate properties:
 *
 *   - **It is hand-written, not bundled.** The browser artifact DSH expects is
 *     a plain `window.__ModuleLoader__.load({ id, factory })` file whose id
 *     equals the package name — no bundler, no duplicate React.
 *   - **It cannot break the host half.** The command menu is decoration; if
 *     registering fails (most likely because a host row already claims the
 *     name, which fails loudly by design), the failure is logged and swallowed
 *     so `/image` itself keeps working unadorned.
 *
 * Not verified visually: this environment has no browser control, so "the row
 * shows this icon" is asserted by the code below, not observed.
 *
 * @module @local/dsh-image/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-image',
  factory(require) {
    const h = require('react').createElement;

    /**
     * Inline SVG so the row needs no bundled asset and no import from a
     * Harness Client package, which `references/practices.md` forbids.
     * `currentColor` lets it follow the host theme.
     */
    function CommandIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          x: 2.5,
          y: 4.5,
          width: 19,
          height: 15,
          rx: 2.5,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('circle', { cx: 9, cy: 9.6, r: 1.8, fill: 'currentColor' }),
        h('path', {
          d: 'M4.6 17.6 L10.2 11.8 L13.3 15 L15.7 12.7 L19.4 17.6 Z',
          fill: 'currentColor',
        }),
      );
    }

    return {
      inject: [],
      apply(ctx) {
        // Fetched rather than injected, for the same reason as the host half:
        // a missing service must not keep this module unapplied.
        ctx.inject(['commandui'], (scope) => {
          try {
            const commands =
              typeof scope.get === 'function' ? scope.get('commandui', false) : scope.commandui;
            if (!commands || typeof commands.register !== 'function') {
              return;
            }
            scope.effect(() =>
              commands.register({
                name: 'image',
                label: () => 'Image',
                description: () => 'Generate an image from a prompt',
                icon: CommandIcon,
              }),
            );
          } catch (error) {
            try {
              console.warn(
                '[dsh-image] command menu metadata not registered:',
                error?.message ?? error,
              );
            } catch {
              /* never throw from a decorated row */
            }
          }
        });
      },
    };
  },
});
