# dsh-flownote-memory

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
that registers the **local `flownote-cli` MCP server** with any Harness
instance. Once installed, the agent gets the
`mcp__flownote__memo` tool to search, read, create, and edit
Flownote Markdown memos, edit rich note content (columns, callouts, toggles,
note cards), build and edit `.fanvas` canvas boards, and create declared
plugin artifacts such as mind maps.

The bundle includes a small launcher. It transparently proxies to `flownote-cli`
when installed; otherwise it keeps the tool registered and returns an
actionable installation error to the agent. The launcher is a `cordis.patch.yml`
that inserts one
[`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/mcp/mcp-client)
row, which ships inside every Harness distribution. Nothing here connects to a
remote Flownote service — the CLI is spawned locally over stdio and reads the
local notebook data directory.

## Prerequisites

1. A `flownote` command on `PATH` (or set `FLOWNOTE_CLI_PATH` to the absolute
   `flownote-cli` binary path) is needed to use the memo operations. If it is
   missing, the tool explains how to install Flownote from
   `https://flownote-memo.com/latest.json`. The CLI is built from the
   [flownote-main](https://github.com/text2future/flownote) repository
   (`app/flownote-cli`, binary `flownote-cli`).
2. Access to the Flownote notebook data the CLI should manage. Defaults to the
   user config directory (`~/.flownote`); override with `FLOWNOTE_HOME` /
   `FLOWNOTE_DATA` when the data lives elsewhere.

## Install

`dsh plugin` manages one profile at a time and requires `--profile <name>`.
Flownote uses the `flownote` profile. In other DSH clients, `flownote` is simply a
custom profile name and can be created by the same command. The bundle remains independent from
Flownote's host/control bridge and ships in the
[flownote-main](https://github.com/text2future/flownote) repository and is not yet
published to npm, so install it from the checkout:

```sh
# from the flownote-main checkout root
dsh plugin --profile flownote add ./dsh-flownote-memory
```

Once published, the npm package installs the same way:

```sh
dsh plugin --profile flownote add dsh-flownote-memory
```

The row activates for that profile. Other DSH clients can start it with
`dsh --profile flownote`; this profile also ships `dsh-appserver` so the
Flownote App Server JSON-RPC surface is available out of the box.

## Verify

Start Harness with the profile you installed into (`dsh --profile flownote`),
then check that the tool is registered:

```
mcp__flownote__memo
```

Prefer structured arguments:

```json
{"action":"search","query":"product plan","notebook":"work","tag":"project/flownote","limit":20}
```

Canvas boards are managed through the same tool, for example:

```json
{"action":"canvas.create","notebook":"work","name":"计划","folder":"画布"}
```
```json
{"action":"canvas.addNotes","address":"work::画布/计划.fanvas","notes":["work::A.md","work::B.md"],"columns":3}
```

The legacy `{ "command": "search ...", "stdin": "..." }` form remains
accepted for compatibility but is no longer the recommended contract.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `FLOWNOTE_CLI_PATH` | `flownote` (PATH lookup) | Absolute path to the flownote-cli executable |

If the CLI is unavailable, calling the tool returns an installation message
with `https://flownote-memo.com/latest.json`. Install Flownote, then restart the
profile so the launcher reconnects to `flownote-cli mcp`.

## Uninstall

```sh
dsh plugin --profile flownote remove dsh-flownote-memory
```

## Notes

- The MCP stdio bridge strips ambient credential-like variables and all
  `DSH_*` variables before spawning the child; other ambient variables
  (including `HOME`/`PATH`) are inherited.
- Flownote Desktop installs this same bundle into its `flownote` profile and sets
  `FLOWNOTE_DSH_MCP_CLI`. Other DSH clients can install it into any profile and
  use `FLOWNOTE_CLI_PATH` or the `flownote` executable on PATH. There is one
  canonical bundle patch and no embedded duplicate row.
