# CLAUDE.md

Unofficial TypeScript reconstruction of the shipped Grok Bot 0.18.0 Electron
app (macOS arm64), plus experiments: an inference Router, a local Docker
sandbox, and the Jarvis voice assistant. Read `README.md`, `PROVENANCE.md` and
`CONTRIBUTING.md` before changing reconstructed runtime or UI code.

## Search economically

The repo is ~7M tokens of text; never read whole directories. About 60% of
`source/` is generated protobuf code that is almost never the answer:

- `source/packages/proto/generated/`
- `source/packages/redacted-protos/generated/`
- `source/electron-main/generated/`
- `*.gen.ts`

The root `.ignore` file already hides them from ripgrep (and from Grep/Glob).
When the question is about a wire format, search them explicitly with
`rg --no-ignore -n PATTERN source/packages/proto/generated`. Start from the
map below, then grep inside the named directory.

## Map

| Area | Path | Notes |
| --- | --- | --- |
| Electron main process | `source/electron-main/` | `main.ts`, `main-edge.ts`, `main-production-services.ts`; one folder per service (auth, box, mcp, secrets, update, voice-assistant, …) |
| Preload / IPC bridge | `source/electron-preload/` | `preload.ts`; contracts in `source/electron-main/production-ipc-contract.ts` |
| Host (agents, extensions, gateway) | `source/host/` | `main.ts`, `gateway-server.ts`, `extensions/` |
| Coordinator | `source/node-agent-coordinator/` | `main.ts`, `inference-router.ts`, `routed-mcp-bridge.ts` |
| Local exec daemons | `source/local-exec-daemon/`, `source/box-exec-daemon/` | |
| Shared types/helpers | `source/shared/` | |
| Agent packages | `source/packages/*` | agent, agent-core, mcp-core, hooks, proto, … |
| Jarvis voice assistant | `source/voice-assistant/` | own `README.md`; Electron shell in `source/electron-main/voice-assistant/` |
| Editable frontend (partial) | `frontend/src/` | `production/`, `recovered/{features,ui,runtime,contracts}`; NOT what ships |
| Build/package/verify scripts | `scripts/`, `scripts/lib/` | `lib/config.mjs` holds build paths |
| Tests | `tests/*.test.mjs` | `node:test` + `node:assert/strict`; TS is bundled with esbuild on the fly |
| Pinned build manifests | `manifests/reconstruction/` | consumed by the build; do not hand-edit hashes |

### Where common features live

- **Inference Router** (Cursor / Claude Code / Codex / OpenRouter):
  provider list and usage types in `source/shared/inference-router.ts`;
  transcript store and routing in `source/node-agent-coordinator/inference-router.ts`;
  provider calls in `source/host/extensions/inference/provider-session.ts`
  (Codex: `codex-direct-responses.ts`). The Settings → Router UI is a string
  patch on the shipped renderer in `scripts/lib/router-renderer-patch.mjs`.
  Tests: `tests/router-settings.test.mjs`, `tests/inference-router-transcript.test.mjs`,
  `tests/codex-direct-responses.test.mjs`.
- **Local Docker sandbox**: `source/electron-main/box/local-docker-host-connector.ts`,
  `source/shared/box-runtime.ts`.
- **Jarvis**: `intent-router.ts` (local commands, no LLM), `grok.ts` +
  `assistant.ts` (xAI tool calls), `elevenlabs.ts` (STT/TTS), `actions.ts`
  (`execFile` only, never a shell), `memory.ts`, `calendar.ts`, `gmail.ts`
  (read-only), `email-alerts.ts`. Tests: `tests/voice-assistant.test.mjs`.
  Windows packaging: `scripts/package-windows.mjs`, `scripts/windows/`,
  `docs/JARVIS_WINDOWS.md`.

## Commands

```sh
npm ci
npm run check            # typecheck (frontend) + source:typecheck + tests
npm test                 # node --test tests/*.test.mjs
npm run frontend:build
npm run publication:check
npm run voice            # Jarvis in a terminal (needs XAI_API_KEY, ELEVENLABS_API_KEY)
```

CI (`.github/workflows/check.yml`) runs `check`, `frontend:build` and
`publication:check` on Node 26.5.0 and needs Git LFS objects. Packaging
(`bootstrap`, `package`, `verify`) only works on macOS.

## Rules

- **Evidence-only reconstruction** (see `PROVENANCE.md`): reconstructed runtime
  or renderer behavior must be backed by an artifact anchor. Never invent a
  screen, label, route or interaction to fill a gap; leave it unmapped. New
  experiments (Router, Docker sandbox, Jarvis) are clearly separate features.
- Never weaken checksum, bundle identity, code-signing or clean-export checks
  to make a build pass.
- Never commit extracted upstream app files, build output (`src/app/dist`,
  `dist/`), recovery workspaces or credentials. Installers in
  `research-archives/` are Git LFS objects with pinned SHA-256.
- Secrets come from the desktop secrets bridge or environment variables, never
  from source files.
- Keep commits focused and say whether they touch runtime source, the editable
  frontend, the pinned renderer patch, or packaging only.
