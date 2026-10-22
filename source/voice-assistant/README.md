# Jarvis voice assistant (Grok + ElevenLabs)

A push-to-talk voice assistant with two front ends that share the same core:

- **Desktop:** a global **Option+Space** shortcut in the reconstructed app,
  which works even when the app is in the background.
- **Terminal:** `npm run voice`.

```text
microphone ──sox/ffmpeg──▶ ElevenLabs Scribe (speech-to-text)
                                   │
                           local intent router ──▶ instant actions (no LLM call)
                                   │ anything else
                                   ▼
                     Grok chat completions + tool calls
                                   │
                    ElevenLabs TTS (eleven_v3, emotion tags)
                                   │
                                speaker
```

- **Local intent router** (`intent-router.ts`): obvious commands such as
  "abre o Spotify", "põe o volume a 40", "que horas são?", "toma nota …" or
  "para!" run immediately, with no API call. If a local guess fails, the request
  goes to Grok instead.
- **Grok** (`grok.ts`, `assistant.ts`): questions and open-ended requests go
  to xAI's OpenAI-compatible `/chat/completions` endpoint, with function tools
  for the same actions. The conversation history is capped and trimmed only at
  user turns.
- **ElevenLabs** (`elevenlabs.ts`): Scribe for transcription, `eleven_v3` for
  speech. Grok may add tags such as `[laughs]` or `[sighs]`; the voice
  performs them and the terminal hides them.
- **Actions** (`actions.ts`): open an app, open an http(s) URL, set the volume,
  tell the time, append a note. Each action runs through `execFile` with
  validated arguments, never through a shell.
- **ASSISTANT.md** (`profile.ts`, `scheduler.ts`): a profile in the spirit of
  CLAUDE.md that sets the persona, the assistant's responsibilities, and daily
  routines. The output of each routine is spoken aloud and appended to a log
  file next to the profile.

## Desktop (Option+Space)

1. Provide `XAI_API_KEY` and `ELEVENLABS_API_KEY` in one of two ways:
   - save them in the app's encrypted secrets store, the same one that holds
     box secrets and `OPENROUTER_API_KEY`; or
   - export them and launch the app from that terminal
     (`open "dist/Grok Bot 0.18 Reconstructed.app"`). An app launched from
     Finder does not see your shell's environment variables.
2. Install a recorder: `brew install sox` (or ffmpeg).
3. Restart the app. The assistant only starts when both keys are present.

Then:

- Press **Option+Space** to start listening (you hear a *Tink*). Press it again
  to send (*Pop*). Recording stops on its own after 30 seconds.
- The reply appears as a notification and is spoken by ElevenLabs.
- Pressing Option+Space while Jarvis is talking interrupts it and starts
  listening again.
- Routines from `ASSISTANT.md` run in the background and are spoken when the
  assistant is idle.
- The first time, macOS asks for microphone permission. The packaged app
  declares `NSMicrophoneUsageDescription` for this.

`JARVIS_SHORTCUT` changes the shortcut (any Electron accelerator, e.g.
`CommandOrControl+Shift+J`); `JARVIS_SHORTCUT=off` turns it off. Electron's
`globalShortcut` only reports key presses, never key releases, and needs a
non-modifier key. That is why the shortcut is Option+Space toggle-to-talk
rather than holding the right Option key on its own.

Source: `desktop-controller.ts` (state machine: idle → listening → thinking →
speaking) and `source/electron-main/voice-assistant/electron-voice-assistant.ts`
(Electron adapter, started from `main-production-services.ts`).

## Terminal setup

```sh
export XAI_API_KEY=...            # https://console.x.ai
export ELEVENLABS_API_KEY=...     # https://elevenlabs.io/app/settings/api-keys
brew install sox                  # or ffmpeg; macOS plays audio with afplay
npm run voice
```

Press **Enter** to start talking and **Enter** again to stop. You can also type
a message. Commands: `/mute`, `/routines`, `/run <routine>`, `/help`, `/quit`.
Pass `--mute` for text-only replies.

| Variable | Default |
| --- | --- |
| `GROK_MODEL` | `grok-4` |
| `XAI_BASE_URL` | `https://api.x.ai/v1` |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (George) |
| `ELEVENLABS_TTS_MODEL` | `eleven_v3` |
| `ELEVENLABS_STT_MODEL` | `scribe_v1` |
| `JARVIS_LANGUAGE` | `pt` (reply language and transcription hint) |
| `JARVIS_PROFILE` | `~/.grok-bot/voice-assistant/ASSISTANT.md` |
| `JARVIS_HISTORY_LIMIT` | `20` messages |

## ASSISTANT.md

The profile is created on the first run. Edit it to change the assistant's
behaviour:

```markdown
# ASSISTANT.md

## Persona
You are Jarvis, a calm, witty voice assistant. Keep answers short enough to listen to.

## What it does
Daily brief · Notes · Open apps and websites · Answer questions

## When it runs
07:00 — Daily brief → log.md
18:00 — End-of-day summary → log.md
```

Each routine runs at most once per day, while the assistant is running. A
routine whose time has already passed when the assistant starts waits until the
next day. Log files must be plain file names; they are written to the profile
directory.

## Platform notes

The assistant is built for macOS (`open`, `osascript`, `afplay`). On Linux it
uses `xdg-open`, `gtk-launch`, `pactl`, and `ffplay` or `mpg123`. On Windows,
microphone capture is not wired up yet, so use typed input there.
