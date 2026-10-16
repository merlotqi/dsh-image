# dsh-image

Image generation for DeepSeek Harness through an OpenAI-compatible relay
(configured for `api.ykh.ai` / `gpt-image-2`).

No dependencies, no build step.

## What it registers

| Surface | Name | Started by |
|---|---|---|
| Slash command | `/image <prompt>` | you |
| Agent tool | `generate_image` | the model |

Both call **one** shared operation (`lib/generate.js`), per DSH's guidance for
user actions and agent tools: *"Do not maintain separate operation logic in the
UI and tool paths."*

The command's result is UI-side and never enters model history, so `/image`
costs no tokens. The tool's result does enter the conversation, which is what
lets the model show the picture and keep working.

## Install

> **Install with `file:`, not `link:`.** This is the one thing that will
> silently break the plugin.

```powershell
dsh plugin --profile <profile> add file:C:/abs/path/to/dsh-image
```

Restart DSH once. Then `/` lists `image`, and the next agent gets
`generate_image`.

### Why `file:` and not `link:`

A `link:`ed package resolves its own imports from the link target's **real
path**. When that path is outside the profile — a workspace, say — the host's
installation-scope resolver does not cover it, so every bare `@deepseek-ai/*`
import fails and the entry is dropped with:

```
dsh: warning: 1 entry did not activate
dsh-image (@local/dsh-image): failed to import
```

That message is a bare literal the loader emits when no fiber could be created,
and nothing else reports it: `--dump-config` only *composes* (it never imports),
and the plugin market reads composition state, not load outcomes. So the
failure is completely silent in the UI.

`file:` installs a real copy inside the profile, where those packages resolve.
(The zero-dependency plugins that get away with `link:` do so by importing
nothing but `node:*` builtins.)

### After editing

`file:` is a **copy**, so the installed plugin does not follow your edits:

```powershell
dsh plugin --profile <profile> remove @local/dsh-image
dsh plugin --profile <profile> add file:C:/abs/path/to/dsh-image
```

Re-running only `add` may be reported as "Already up to date" and skip the copy,
so remove first.

## The API key

The config holds only the **name** of a credential reference. The value is
resolved per operation through DSH's credential service, so rotating the key
never needs a restart. Resolution order (fixed by DSH, highest wins):

1. the environment DSH was launched with
2. `~/.dsh/.credentials.yaml`
3. `<project>/.env`, then `$DSH_HOME/.env`

To set it persistently, add it to `~/.dsh/.credentials.yaml` — the store reloads
on change:

```yaml
version: 1
refs:
  YKH_API_KEY: <your key>
```

Two things that quietly produce "no key":

- an **empty** value (`YKH_API_KEY:` with nothing after it) — DSH treats a blank
  as absent, and also lists empty values among the things it refuses;
- a missing space after the colon (`YKH_API_KEY:sk-…` is parsed as one plain
  string, not a mapping).

The key is never written into this plugin's config, never logged, and never sent
anywhere except the configured relay.

> **Caveat, from DSH's own documentation:** the shipped credential provider is
> file-backed, and *file permissions cannot keep a key away from the agent* —
> the agent's tool processes run as your OS user. A keyring or KMS provider
> exists only as an unimplemented seam. If that matters, do not put the key in
> the credential file.

## Configuration

Change these in the profile patch, not in code — the user's patch layer survives
upgrades:

```yaml
- id: dsh-image
  name: '@local/dsh-image'
  config:
    baseUrl: https://api.ykh.ai/v1
    model: gpt-image-2
    apiKeyRef: YKH_API_KEY
    defaultSize: 1024x1024
    requestTimeoutMs: 180000
    outputDir: images
```

`baseUrl` is everything up to but not including `/images/generations`, so
switching relays is a config edit.

## Response shapes

The relay's response format is **not assumed**. The client branches on the
`content-type` and handles all three shapes seen in the wild:

| Shape | Handling |
|---|---|
| raw bytes, `image/*` | written straight to disk |
| JSON `data[0].b64_json` | base64-decoded (OpenAI's own behaviour for gpt-image) |
| JSON `data[0].url` | downloaded, then written |

The shape actually used is reported in the tool result, the log line and the
command summary, so a first run resolves the question instead of us guessing.
`test/relay.test.mjs` covers all three plus the failure modes.

## Output

Images are written to `<session workspace>/<outputDir>/<timestamp>-<slug>.<ext>`.

Two paths are reported:

- `path` — absolute, for tools that need a real filesystem path
- `relPath` — workspace-relative with forward slashes, for markdown
  `![description](relPath)`

An absolute Windows path in a markdown image reference is both an escape hazard
and unresolvable by the transcript's loader, which resolves against the session
workspace.

## Development

```
index.js            wiring: identity, config schema, caller registration
client.js           browser half: the command row's label/description/icon
lib/generate.js     the one operation both callers use
lib/command.js      /image adapter
lib/tool.js         generate_image adapter
lib/relay.js        HTTP client (three response shapes)
lib/credentials.js  API-key resolution
lib/config.js       defaults + the config merge
lib/context.js      service lookup helper
lib/errors.js       error type + logging
test/relay.test.mjs relay tests (stubbed fetch; no host, no network, no key)
```

Run the tests:

```sh
npm test              # node --test test/
node test/relay.test.mjs   # same tests, in-process
```

## Deliberately not included

- **No client bundle.** The `/` entry works from the host-side registration
  alone (`input.hint` makes it a `leadingInput` command). `client.js` is plain
  hand-written JS in the shape DSH's module loader expects — there is no
  rolldown/tsdown build step.
- **No size/quality popup** — that would be the first thing to need a real
  client contribution.
- **No cost guard.** DSH can await confirmation from a `tools/pre-execute`
  listener returning `ask`; that belongs on model-initiated calls.
- **No batch / multi-image** — `data[0]` only.
