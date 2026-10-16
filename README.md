# dsh-image

Image generation for DeepSeek Harness through an OpenAI-compatible relay
(configured for `api.ykh.ai` / `gpt-image-2`).

A **host-only bundle**: no dependencies, no build step. Three files plus the
HTTP client.

## What it registers

| Surface | Name | Who starts it |
|---|---|---|
| Slash command | `/image <prompt>` | you |
| Agent tool | `generate_image` | the model |

Both call one shared operation, per DSH's guidance for user actions and agent
tools — there is no second copy of the logic.

## The API key

The plugin config holds only the **name** of a credential reference. The value
is resolved per operation through DSH's credential service, so rotating the key
never needs a restart. Resolution order (fixed by DSH, highest wins):

1. the environment DSH was launched with
2. `~/.dsh/.credentials.yaml`
3. `<project>/.env`, then `$DSH_HOME/.env`

To set it persistently, edit `~/.dsh/.credentials.yaml` (the store reloads on
change):

```yaml
version: 1
refs:
  YKH_API_KEY: <your key>
```

Or export it before launching DSH:

```powershell
$env:YKH_API_KEY = '<your key>'
```

The key is never written into this plugin's config, never logged, and never
sent anywhere except the configured relay.

> **Caveat, from DSH's own documentation:** the shipped credential provider is
> file-backed, and *file permissions cannot keep a key away from the agent* —
> the agent's tool processes run as your OS user. A keyring or KMS provider
> exists only as an unimplemented seam in DSH. If that matters, do not put the
> key in the credential file.

## Configuration

Change these in the profile patch, not in code — the user's patch layer
survives upgrades:

```yaml
- id: dsh-image
  name: '@local/dsh-image'
  config:
    baseUrl: https://api.ykh.ai/v1
    model: gpt-image-2
    apiKeyRef: YKH_API_KEY
    defaultSize: 1024x1024
    requestTimeoutMs: 180000
    outputDir: dsh-image
```

## Response shapes

The relay's response format is **not assumed**. The client branches on the
`content-type` and handles all three shapes seen in the wild:

| Shape | Handling |
|---|---|
| raw bytes, `image/*` | written straight to disk |
| JSON `data[0].b64_json` | base64-decoded (OpenAI's own behaviour for gpt-image) |
| JSON `data[0].url` | downloaded, then written |

The shape actually used is reported in the result and the log line, so the
first real run resolves the question instead of us guessing.

## Output

Images are written to `<session workspace>/<outputDir>/<timestamp>-<slug>.<ext>`.

Two paths are reported:

- `path` — absolute, for tools that need a real filesystem path
- `relPath` — workspace-relative with forward slashes, for markdown
  `![description](relPath)`

An absolute Windows path in a markdown image reference is both an escape hazard
and unresolvable by the transcript's loader, which resolves against the session
workspace.

## Deliberately not included (yet)

- **No client bundle.** The `/` entry works from the host-side registration
  alone (`input.hint` makes it a `leadingInput` command), so there is no
  rolldown/tsdown build step and no `client.js`.
- **No size/quality popup** — that would be the first thing to need a client
  bundle.
- **No cost guard.** DSH can await confirmation from a `tools/pre-execute`
  listener returning `ask`; that belongs on model-initiated calls, and `/image`
  is already an explicit human intent.
- **No batch / multi-image** — `data[0]` only.
