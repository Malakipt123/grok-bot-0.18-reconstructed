---
name: jarvis-debug
description: Debug the Jarvis voice assistant (source/voice-assistant). Use for /jarvis-debug, or when Jarvis mishears, does not answer, answers slowly, runs the wrong local command, forgets things, misses a reminder or calendar/Gmail alert, cannot open a Meet, or fails on Windows.
---

# Debug Jarvis

Jarvis is a push-to-talk pipeline. Find which stage fails before reading code:

```text
mic (audio.ts: sox/ffmpeg) → STT (elevenlabs.ts: Scribe) → intent-router.ts
  ├─ local action, no LLM (actions.ts: execFile only)
  └─ Grok (grok.ts + assistant.ts: xAI chat completions + tools)
       → TTS (elevenlabs.ts: eleven_v3) → speaker
```

Background pieces: `memory.ts` (facts + recent turns), `scheduler.ts` and
`profile.ts` (ASSISTANT.md routines), `reminders.ts` / `voice-reminders.ts`,
`calendar.ts`, `gmail.ts` (read-only), `email-alerts.ts`, `google-auth.ts`.
`runtime.ts` wires them together. Desktop shell, HUD and key setup live in
`source/electron-main/voice-assistant/`.

## 1. Map the symptom to a stage

| Symptom | Start in | Test name contains |
| --- | --- | --- |
| No recording, silence, wrong mic | `audio.ts` (`JARVIS_MIC`, sox/ffmpeg on PATH) | `audio`, `mic` |
| Transcript wrong | `elevenlabs.ts` (`ELEVENLABS_STT_MODEL`, `JARVIS_LANGUAGE`) | `transcri` |
| Simple command went to Grok, or the wrong action ran | `intent-router.ts`, then `actions.ts` | `router` |
| Grok error, no reply, wrong tool | `grok.ts`, `assistant.ts` (`XAI_API_KEY`, `GROK_MODEL`, `XAI_BASE_URL`) | `Grok`, `tool` |
| Forgets facts or the conversation | `memory.ts` (`JARVIS_MEMORY`, `JARVIS_HISTORY_LIMIT`, `JARVIS_CONVERSATION_TTL_HOURS`) | `memory`, `remember` |
| Reminder late, missing or repeated | `reminders.ts`, `voice-reminders.ts` (`JARVIS_REMINDER_MINUTES`, `JARVIS_TIMEZONE`) | `reminder`, `snooze` |
| Calendar / Meet | `calendar.ts`, `google-auth.ts` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) | `calendar`, `meet` |
| Email alerts / Gmail | `gmail.ts`, `email-alerts.ts` (`JARVIS_EMAIL_ALERTS`) | `email`, `Gmail` |
| Voice change | `voices.ts` (`ELEVENLABS_VOICE_ID`) | `voice changes` |
| HUD, shortcut, Windows tray or keys window | `source/electron-main/voice-assistant/` (`JARVIS_HUD`, `JARVIS_SHORTCUT`) | `setup`, `icon` |

Read only the files in that row. Don't open the rest of `source/`.

## 2. Reproduce without keys or a microphone

The tests bundle each module with esbuild and fake the network and processes,
so they run in a cloud session:

```sh
node --test --test-name-pattern "router" tests/voice-assistant.test.mjs
npm test   # all tests
```

Write a failing test in `tests/voice-assistant.test.mjs` that reproduces the
report before changing code. Follow the existing style: `loadModule(...)`,
`actionContext(...)`, `node:assert/strict`.

## 3. Reproduce with real keys (the user's machine)

Typed input skips the microphone and STT, which splits the pipeline in half:

```sh
XAI_API_KEY=... ELEVENLABS_API_KEY=... npm run voice
```

Useful commands: `/help`, `/memory`, `/forget …`, `/reminders`,
`/reminders cancel r1`, `/google`, `/routines`, `/mute`, `/run …`, `/quit`.
For quick reminders, start with `JARVIS_REMINDER_MINUTES=2`. State lives in
`~/.grok-bot/voice-assistant/` (`ASSISTANT.md`, `memory.json`,
`google-token.json`, `voice.json`); those files must be mode 0600.

For the full manual checklist (in Portuguese), use
`docs/VOICE_ASSISTANT_TESTING.md`. For Windows, use `docs/JARVIS_WINDOWS.md`
and the `JARVIS_SMOKE_LOG` smoke run in `.github/workflows/jarvis-windows.yml`.

## 4. Fix and verify

- Keep the safety rules: actions use `execFile` with validated arguments,
  never a shell; Gmail stays read-only, and email content is untrusted (it
  must never trigger tools); secrets never go into `memory.json`; meeting links
  must be real https video-call hosts.
- Run `npm run check`. If the fix touches the Electron shell or Windows
  packaging, it also runs in the Jarvis for Windows CI workflow.
- When a manual step can't run here, say which item of
  `docs/VOICE_ASSISTANT_TESTING.md` the user should run.
