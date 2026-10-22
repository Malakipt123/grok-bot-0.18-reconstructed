# Jarvis voice assistant (Grok + ElevenLabs)

A standalone push-to-talk voice assistant that lives beside the reconstructed
app. It does not touch the Electron runtime or the packaged renderer.

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

## Setup

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
