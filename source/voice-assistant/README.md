# Jarvis voice assistant (Grok + ElevenLabs)

A push-to-talk voice assistant with two front ends that share the same core:

- **Desktop:** a global **Option+Space** shortcut in the reconstructed app,
  which works even when the app is in the background.
- **Terminal:** `npm run voice`.
- **Jarvis on its own:** `npm run jarvis` starts just the assistant in
  Electron, with a tray icon, the global shortcut and the HUD. This is how
  Windows and Linux use the desktop assistant; see [Windows](#windows).

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

Manual test checklist for a Mac with real keys (in Portuguese): [docs/VOICE_ASSISTANT_TESTING.md](../../docs/VOICE_ASSISTANT_TESTING.md).

## Memory between sessions

Jarvis remembers across restarts, in `memory.json` next to `ASSISTANT.md`.
The file is private to your user (`0600`), written atomically, and never
leaves your machine except as context in Grok requests.

- **Long-term facts.** Saying "lembra-te que …" / "remember that …" stores the
  fact instantly, without calling Grok. Grok can also call `remember` when you
  mention something durable (your name, preferences, people, routines) and
  `forget` when you ask it to. Facts go into every prompt, newest first, within
  a 4,000-character budget, and routines see them too. That is how the 07:00
  brief knows who it is talking to. At most 200 facts are kept; the
  longest-untouched one makes room for a new one, and repeating a fact updates
  it instead of creating a duplicate.
- **Recent conversation.** The last turns are saved after each reply and
  restored on restart if they are newer than `JARVIS_CONVERSATION_TTL_HOURS`
  (default 12). After that a new conversation starts, but the facts stay.
- **Never stored:** anything that looks like a password, PIN, CVV, IBAN,
  verification code or card number. This is refused both on the local path and
  in the tool.
- **Your control:** `/memory` lists facts with their ids, `/forget m3` removes
  one, and `/forget all` clears facts and the saved conversation. By voice, ask
  "esquece que …". `JARVIS_MEMORY=off` turns memory off entirely.
- An unreadable `memory.json` is never overwritten. It is moved aside as
  `memory.json.corrupt-<timestamp>` and reported.

## Changing the voice

Say **"usa uma voz feminina"**, "quero uma voz masculina britânica" or "volta
à voz normal". Grok lists the voices in your ElevenLabs account (premade ones,
plus any you cloned or added from the Voice Library), picks the best match and
switches. The confirmation is already spoken in the new voice. To get more
choices, add voices to your account in the ElevenLabs Voice Library.

The choice is saved in `voice.json` (0600) next to `ASSISTANT.md` and wins
over `ELEVENLABS_VOICE_ID` on restart; "volta à voz normal" removes it. Only
voices that really exist in the account can be chosen.

## Voice reminders and snooze

These work without Google Calendar.

- **"Lembra-me de ligar à Ana às 17h"** or **"remind me to stretch in 20
  minutes"**: Grok calls `reminder_set` with a local time in your time zone,
  and Jarvis says "Lembrete: ligar à Ana." when it is due. Grok can also list
  and cancel pending reminders ("o que tenho para me lembrares?", "cancela o
  lembrete da Ana").
- **"Adia"**, **"adia 10 minutos"** or **"lembra-me daqui a 5 minutos"**,
  right after any announcement (a voice reminder, a routine or a calendar
  reminder), repeats it that many minutes later. The default is 5 minutes. It
  is handled locally, with no Grok call. A snoozed meeting reminder counts the
  minutes left again ("Daqui a 5 minutos tens…"). Jarvis refuses to snooze past
  the start of the meeting.
- Reminders are kept in `reminders.json` (`0600`, atomic writes) next to
  `ASSISTANT.md`, so they survive restarts. One missed while Jarvis was closed
  is still said on the next start, as "Ficou por dizer um lembrete: …", if it
  is at most 12 hours late. Older ones are dropped. They use the same
  announcement queue as calendar reminders, so they never talk over you.
- In the terminal, `/reminders` lists pending reminders and
  `/reminders cancel r3` removes one.

## Google Calendar

Jarvis can read your agenda and create events in your primary Google Calendar.
It uses the official Calendar API with OAuth for desktop apps: you sign in in
your browser, Google redirects to a one-shot server on `127.0.0.1`, and the
code is exchanged with PKCE. Only the refresh token is kept, in
`google-token.json` (`0600`) next to `ASSISTANT.md`. The scopes are
`calendar.events` (events only) and `gmail.readonly` (see [Gmail](#gmail)):
nothing else in your Google account.

**One-time setup (about 5 minutes).** Google requires your own OAuth client;
none can be shipped in this repository.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Calendar API** and the **Gmail API**.
2. Under **Google Auth Platform**, configure the consent screen (External,
   Testing is fine) and add your Google account as a **test user**.
3. Under **Clients**, create a client of type **Desktop app**, then copy its
   ID and secret.
4. Provide `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, either as
   environment variables or in the app's secrets store, like the other keys.
5. Say **"liga o calendário"**, "liga o Google" ("connect my calendar") or run
   `/google connect` in the terminal, then approve access in your browser.

Then ask things like "o que tenho amanhã?", "estou livre na sexta à tarde?" or
"marca dentista terça às 10:30 no Porto". Jarvis confirms the title, day and
time before creating an event unless you already said all of them. The daily
brief includes today's agenda.

- **Proactive reminders.** Ten minutes before each timed event, Jarvis says
  "Daqui a 10 minutos tens Reunião com a Ana, em Lisboa." and the HUD shows it.
  If the meeting is already inside that window when the app starts, you hear
  the real number of minutes left, or "Está a começar agora". All-day events
  are skipped.
  - The calendar is checked every 5 minutes, and each event gets its own
    timer, so a reminder fires on time rather than at the next check. Moved
    events are rescheduled and cancelled ones are dropped. Each event is
    announced once.
  - Reminders never talk over you. During a conversation they wait until Jarvis
    is idle, and they play one at a time. One that only becomes speakable after
    the event has started is shown as a notification instead. Routine
    briefings use the same queue, and are still spoken within 30 minutes of a
    conversation ending.
  - The text is built locally, so a reminder costs one Calendar request per
    check and no Grok call. A failing calendar is reported once per outage,
    not every 5 minutes.
  - **Join from the reminder.** When the event has a video call, the reminder
    ends with "Diz «abre a reunião» para entrares." Press Option+Space and say
    **"abre a reunião"** (also "entra na reunião", "abre o Meet", "join the
    meeting") to open the call in your browser. This is handled locally, with
    no Grok call and no Calendar request for the meeting that was just
    announced. Without a recent reminder, the same phrase opens the meeting in
    progress or starting within 15 minutes. Grok can also do it through
    `calendar_join_meeting` ("entra na reunião das três"). The agenda marks
    such events as `[Google Meet]` or `[video call]` instead of reading out
    links.
  - **Only real call links are opened.** The link comes from Google's own
    conference data (`hangoutLink` and video entry points) first, then from a
    URL in the location or description. Because anyone can send you an invite,
    only `https` links on `meet.google.com`, `zoom.us`, `teams.microsoft.com`
    or `teams.live.com` are accepted, and look-alikes such as
    `meet.google.com.evil.example` are not. The check is repeated right
    before opening.
  - `JARVIS_REMINDER_MINUTES` changes the lead time (default `10`, at most
    `120`); `off` disables reminders.
- Times use the system time zone, or `JARVIS_TIMEZONE` (IANA name, e.g.
  `Europe/Lisbon`). DST is handled.
- Until you connect, Grok gets no calendar tools. It only knows to tell you
  how to connect.
- If access is revoked, Jarvis forgets the token and asks you to reconnect.
  `/google disconnect` deletes the token and revokes it at Google.
- While the consent screen is in *Testing*, Google expires refresh tokens after
  7 days, so you have to reconnect weekly. Switching the app to *In
  production* removes that limit. Because `calendar.events` is a sensitive
  scope, an unverified app then shows an "unverified app" warning at sign-in,
  which you can accept for your own account.

## Gmail

The same Google sign-in also lets Jarvis **read** your email. Ask "tenho
emails importantes?", "o que diz o email da Ana?" or "recebi alguma coisa do
banco esta semana?". The daily brief mentions important unread email too.

- **Read-only.** The scope is `gmail.readonly`, so Jarvis cannot send, reply,
  delete, label or change anything, even if asked.
- Tools: `gmail_search`, which takes Gmail search syntax and defaults to
  `is:unread category:primary newer_than:2d`, and `gmail_read`, which returns
  the text of one message, cut at 4,000 characters.
- **Untrusted content.** Emails are written by other people, so their content
  reaches Grok marked as untrusted data. Grok is told never to follow
  instructions found in an email, and never to open links, create events, set
  reminders or remember facts because an email asks to.
- **Privacy.** To summarise an email, its sender, subject and text are sent to
  Grok (xAI). Nothing is stored locally.
- **Already connected before Gmail support?** Your consent only covers
  Calendar. Say **"liga o Google"** (or run `/google connect`) once more and
  tick Gmail; `/google status` shows whether Gmail is allowed. Google's
  consent screen lets you untick Gmail, and then Jarvis just says it has no
  access.
- In Google Cloud, enable the **Gmail API** in the same project. While the
  app is in Testing, Google shows an "unverified app" warning; continue as
  the test user.

## Desktop (Option+Space)

![Jarvis HUD: listening, thinking and speaking](../../docs/assets/jarvis-hud.png)

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
- Replies **stream**. Grok's tokens appear in the HUD word by word as they
  arrive, and each finished sentence is sent to ElevenLabs while Grok is still
  writing the next one. Jarvis starts talking after the first sentence instead
  of waiting for the whole answer. Each word lights up exactly when it is
  spoken, using ElevenLabs character timestamps:

  ![Streaming reply: spoken words bright, upcoming words dimmed](../../docs/assets/jarvis-hud-streaming.png)
- A floating **HUD** appears at the top of the screen with an arc-reactor ring
  and a live waveform. While you speak it follows your microphone; while
  Jarvis answers it follows the reply audio. The ring turns amber while Grok
  thinks, and the HUD shows what you said and what Jarvis answers. It never
  takes focus and lets clicks pass through. It fades out a few seconds after
  Jarvis finishes. `JARVIS_HUD=off` falls back to OS notifications.
- Pressing Option+Space while Jarvis is thinking or talking interrupts it:
  the Grok stream is aborted, queued speech is dropped, and it starts listening
  again.
- Routines from `ASSISTANT.md` run in the background and are spoken when the
  assistant is idle.
- The first time, macOS asks for microphone permission. The packaged app
  declares `NSMicrophoneUsageDescription` for this.

`JARVIS_SHORTCUT` changes the shortcut (any Electron accelerator, e.g.
`CommandOrControl+Shift+J`); `JARVIS_SHORTCUT=off` turns it off. Electron's
`globalShortcut` only reports key presses, never key releases, and needs a
non-modifier key. That is why the shortcut is Option+Space toggle-to-talk
rather than holding the right Option key on its own.

Source:

- `desktop-controller.ts`: state machine (idle → listening → thinking →
  speaking) that emits HUD events;
- `source/electron-main/voice-assistant/electron-voice-assistant.ts`: the
  Electron adapter, started from `main-production-services.ts`;
- `hud-window.ts` / `hud-page.ts`: the HUD window and its page. The page runs
  sandboxed with no Node access, under a CSP that blocks all network access.
  It only receives JSON events.

Streaming (`speech-pipeline.ts`): `SentenceChunker` cuts the token stream at
sentence ends. It ignores numbers like `9.30` and merges very short fragments,
and it may cut the first sentence at a comma so the voice starts sooner.
`AudioTagFilter` hides `[laughs]`-style tags from the text even when a tag is
split across deltas; ElevenLabs still receives them. `SpeechPipeline` runs at
most two TTS requests at a time and plays sentences strictly in order. For
models that support it, it passes the earlier text as `previous_text` so
intonation carries across sentences.

Word-exact captions: with the HUD on, each sentence is synthesised through
ElevenLabs `/with-timestamps`, which returns the same PCM audio plus the start
time of every character. `alignWordStarts` maps those times to the visible
words. Characters inside `[audio tags]` count as separators, and the mapping
works whether or not the alignment includes the tags. Each word then gets its
own timer and lights up at the millisecond it begins.

If the timing does not match the visible words (for example, `Tudo[sighs]bem`
in an alignment that drops the tag), that sentence falls back to spreading the
words evenly. If the endpoint itself is refused with a 4xx error (other than
429), timestamps are switched off for the session, the failure is reported
once, and plain synthesis is used. Outages and rate limits are reported as
normal errors.

Recording streams raw PCM from sox/ffmpeg into Node, and ElevenLabs returns
raw PCM (`pcm_22050`). The waveform is computed from the same audio you hear,
with no MP3 decoder or native module.

## Terminal setup

```sh
export XAI_API_KEY=...            # https://console.x.ai
export ELEVENLABS_API_KEY=...     # https://elevenlabs.io/app/settings/api-keys
brew install sox                  # or ffmpeg; macOS plays audio with afplay
npm run voice
```

Press **Enter** to start talking and **Enter** again to stop. You can also type
a message. Replies print as they stream and are spoken sentence by sentence. Commands: `/mute`, `/routines`, `/run <routine>`, `/memory`,
`/forget <id|all>`, `/reminders`, `/reminders cancel <id>`,
`/google connect|status|disconnect`, `/help`, `/quit`.
Pass `--mute` for text-only replies.

| Variable | Default |
| --- | --- |
| `GROK_MODEL` | `grok-4` |
| `XAI_BASE_URL` | `https://api.x.ai/v1` |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (George); a voice chosen by voice wins |
| `ELEVENLABS_TTS_MODEL` | `eleven_v3` |
| `ELEVENLABS_STT_MODEL` | `scribe_v1` |
| `JARVIS_LANGUAGE` | `pt` (reply language and transcription hint) |
| `JARVIS_PROFILE` | `~/.grok-bot/voice-assistant/ASSISTANT.md` |
| `JARVIS_HISTORY_LIMIT` | `20` messages |
| `JARVIS_MEMORY` | on (`off` disables `memory.json`) |
| `JARVIS_CONVERSATION_TTL_HOURS` | `12` (restore the last conversation if newer) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset (Calendar off) |
| `JARVIS_TIMEZONE` | system time zone |
| `JARVIS_REMINDER_MINUTES` | `10` (`off` disables event reminders) |

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

## Windows

On Windows Jarvis runs on its own, without the macOS-only Grok Bot app. A
Portuguese step-by-step guide is in
[docs/JARVIS_WINDOWS.md](../../docs/JARVIS_WINDOWS.md).

**Installer.** [`Jarvis-Setup.exe`](https://github.com/Malakipt123/grok-bot-0.18-reconstructed/releases/download/jarvis-windows-latest/Jarvis-Setup.exe)
is a per-user install with no administrator rights, a Start menu shortcut and
an uninstaller. It bundles ffmpeg. On first run a **setup window** asks for
the keys, which are stored with Electron `safeStorage` (DPAPI) in
`%APPDATA%\Jarvis\keys.json`; environment variables still win. The
installed app starts at login from its first run (a `Jarvis` value under
`HKCU\...\Run`, removed on uninstall); turning it off in the tray menu
sticks. `Jarvis.exe` carries the ring icon and "Jarvis" version info,
rewritten with `resedit` during packaging.
`npm run package:windows` builds it on Linux or macOS with NSIS.
`.github/workflows/jarvis-windows.yml` builds it on Ubuntu, installs,
launches and uninstalls it on a Windows runner, and on `main` publishes it as
the `jarvis-windows-latest` release. Electron's zip is checked against its own
checksums and ffmpeg against a pinned SHA-256.

**From source:**

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg Git.Git
git clone https://github.com/Malakipt123/grok-bot-0.18-reconstructed.git
cd grok-bot-0.18-reconstructed
npm ci --ignore-scripts            # skips native builds Jarvis does not need
node node_modules/electron/install.js
setx XAI_API_KEY "..."             # saved for new terminals and the login item
setx ELEVENLABS_API_KEY "..."
# open a new terminal, then:
npm run jarvis
```

- The shortcut is **Ctrl+Alt+Space**: Alt+Space is the window menu (and
  PowerToys Run) on Windows. `JARVIS_SHORTCUT` changes it.
- The tray icon (a cyan ring) shows the status and has **Start at login**,
  **Open Jarvis folder** and **Quit**.
- Recording uses ffmpeg with DirectShow and picks the first microphone. If
  that is the wrong one, list them with
  `ffmpeg -list_devices true -f dshow -i dummy` and set `JARVIS_MIC` to the
  exact name, for example `setx JARVIS_MIC "Microphone (USB Audio)"`.
- Replies play through PowerShell's built-in `System.Media.SoundPlayer`, and
  the start/stop sounds are Windows' own *Speech On* and *Speech Off*.
- Windows asks nothing the first time, but **Settings → Privacy & security →
  Microphone → Let desktop apps access your microphone** must be on.
- "volume a 30" presses the volume keys (50 steps down, then up in 2 % steps),
  so the volume overlay appears briefly.
- App secrets are not available outside the macOS app, so keys come from the
  environment only. `npm run voice` also works in the same terminal.

## Platform notes

The assistant is built for macOS (`open`, `osascript`, `afplay`). On Linux it
uses `xdg-open`, `gtk-launch`, `pactl`, and `ffplay` or `aplay`. On Windows it
uses PowerShell (`Start-Process`, `SoundPlayer`, volume keys), `explorer` for
links and ffmpeg for the microphone; actions never go through `cmd.exe`.
