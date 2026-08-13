# Prompt: Add voice command support to Tauri app

> Fill in every `[BRACKETED]` placeholder before sending. Delete sections that don't apply.

---

## Context

I'm adding wake-word voice commands to an existing Tauri 2 desktop app.

- **App**: [WHAT THE APP DOES, e.g. "helmet servicing tracker — logs cleans, inspections, and customer jobs"]
- **Frontend**: React + TypeScript + [Vite/Next], state via [Zustand/Redux/Context]
- **Backend**: Rust (Tauri 2), [any existing plugins in use]
- **Target platforms**: [Windows only / Windows + macOS]
- **Repo root**: frontend in `[src/]`, Tauri in `src-tauri/`

## Goal

Say "Hey Jarvis" → app wakes → I speak a command → the app executes it against
existing app state and gives spoken + visual feedback.

Ship this as a **Python sidecar** for the audio pipeline, not native Rust. The
sidecar must own *only* audio capture, wake detection, and transcription. All
intent handling, actions, and speech output live in the TypeScript app so they
can reuse existing stores, routes, and API clients.

## Architecture — do not deviate

```
mic → openWakeWord → faster-whisper → JSON lines on stdout
                                            ↓
                            Rust sidecar reader → app.emit("voice", ...)
                                            ↓
                              React listener → intent router → app actions
                                            ↓
                                  tauri-plugin-tts for spoken reply
```

## Step 1 — Python sidecar

Create `sidecar/voice_daemon.py`:

- Deps: `numpy sounddevice openwakeword faster-whisper`
- `openwakeword.model.Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")`
- Audio: 16kHz, mono, int16, **blocksize exactly 1280** (openWakeWord requires 80ms frames)
- After wake fires: call `wake.reset()` and drain the audio queue, otherwise the
  wake phrase itself gets transcribed as part of the command
- End-of-speech: RMS energy gate. Stop after ~1.2s below `SILENCE_RMS` (env var,
  default 500), hard cap ~8s
- STT: `faster-whisper` `tiny.en`, `compute_type="int8"`, `device="cpu"`,
  `no_speech_threshold=0.6` — **required**, Whisper hallucinates sentences on
  silent audio without it
- Read model dir from `JARVIS_MODEL_DIR` env var, pass to `download_root`
- Read `WAKE_THRESHOLD` and `SILENCE_RMS` from env

**Protocol — newline-delimited JSON on stdout, one object per line:**

```
{"type":"ready"}
{"type":"wake"}
{"type":"listening"}
{"type":"transcript","text":"log a clean for the AGV K6"}
{"type":"error","message":"..."}
{"type":"stopped"}
```

Accepts on stdin: `{"cmd":"pause"}`, `{"cmd":"resume"}`, `{"cmd":"shutdown"}`

**Critical:** `sys.stdout.flush()` after every emit. Python block-buffers stdout
when not attached to a TTY and Tauri will see nothing. All human-readable logging
goes to **stderr only** — never mix it into stdout or it corrupts the protocol.

Also create `sidecar/calibrate.py`: lists input devices and prints live RMS so I
can pick a `SILENCE_RMS` value for my room.

## Step 2 — Build + bundle config

- PyInstaller: `pyinstaller --onefile --name jarvis sidecar/voice_daemon.py`
- Output goes to `src-tauri/binaries/jarvis-<TARGET_TRIPLE>[.exe]`
- Add a `scripts/build-sidecar.[ps1|sh]` that builds and renames using the triple
  from `rustc -Vv`
- `tauri.conf.json`: `"bundle": { "externalBin": ["binaries/jarvis"] }`
- `src-tauri/capabilities/default.json`: add `shell:allow-spawn` scoped to
  `{ "name": "binaries/jarvis", "sidecar": true }` — note it's `allow-spawn`,
  not the default `allow-execute`, because we use `.spawn()`
- Add `src-tauri/binaries/` and `sidecar/{build,dist}/` to `.gitignore`

## Step 3 — Rust glue

In `src-tauri/src/`:

- `#[tauri::command] async fn start_voice(app)` — spawns the sidecar via
  `app.shell().sidecar("jarvis")`, injects `JARVIS_MODEL_DIR` from
  `app.path().app_data_dir()`
- Reads `CommandEvent::Stdout`, splits on newlines, parses each line as JSON,
  re-emits via `app.emit("voice", value)`. `CommandEvent::Stderr` goes to
  `eprintln!` only
- Store the `CommandChild` in managed state; add `stop_voice` and kill the child
  on `WindowEvent::Destroyed` — otherwise an orphaned Python process holds the
  mic open after the app closes
- Handle sidecar crash: emit `{"type":"error"}` to the frontend rather than
  panicking

## Step 4 — React integration

- `src/voice/useVoice.ts` — hook that `listen<VoiceEvent>('voice', ...)`,
  exposes `{ status, lastTranscript, start, stop, pause }`. Discriminated union
  type for `VoiceEvent` matching the protocol above. Clean up the listener on unmount.
- `src/voice/intents.ts` — intent router. Array of `{ pattern: RegExp, handler }`,
  first match wins, specific patterns before general ones. Normalize input
  (lowercase, strip trailing punctuation) before matching.
- Handlers call **existing app code** — [NAME THE STORES/HOOKS/SERVICES IT SHOULD
  CALL, e.g. "useJobsStore().addServiceRecord()", "the api client in src/lib/api.ts"]
- `src/voice/VoiceIndicator.tsx` — small persistent UI showing idle / listening /
  thinking, plus the last transcript so I can see what it misheard
- Spoken replies via `tauri-plugin-tts`. Keep replies to one short sentence.

## Intents to implement

| Say | Does |
|---|---|
| [e.g. "log a clean for {model}"] | [creates a service record] |
| [e.g. "show me today's jobs"] | [navigates to /jobs?date=today] |
| [e.g. "how many jobs are pending"] | [reads count from store, speaks it] |
| "never mind" / "cancel" | aborts, returns to idle |

Unmatched input → speak "I didn't catch that" and show the raw transcript in the
indicator so I can add a pattern for it.

## Constraints

- **No `run_arbitrary_shell` style intent.** Every action is a narrow typed
  function. Worst case for a misheard command must be a wrong navigation, never
  data loss or a destructive write.
- Any intent that deletes or modifies existing records must ask for spoken
  confirmation before executing.
- Don't add a cloud STT/LLM dependency. This must work fully offline.
- Don't bundle model weights into the binary — download on first run into
  `app_data_dir()` and show progress in the UI.
- Keep TypeScript strict-mode clean and match the existing lint/format config.

## macOS (if targeting it)

- `src-tauri/Info.plist` with `NSMicrophoneUsageDescription`
- `com.apple.security.device.audio-input` in entitlements if hardened runtime is on
- Without these the sidecar receives silence with **no error**, which looks
  identical to a broken wake word — call this out in the README

## Deliverables

1. All files above, working end to end
2. `sidecar/requirements.txt`
3. `docs/VOICE.md` — setup, how to run calibrate.py and set `SILENCE_RMS`, how to
   add a new intent, and a troubleshooting table covering: wake word never fires
   (lower threshold), fires constantly (raise it), transcribes sentences I never
   said (SILENCE_RMS too high), cuts me off mid-sentence (SILENCE_RMS too high or
   silence frames too low), no audio device found, PyInstaller binary flagged by
   Windows Defender

## Before you start

Read the existing code and confirm the intent handlers hook into the real stores
and services rather than duplicating logic. Ask me about anything ambiguous in
the intent table before writing code. Show me the plan first — I want to approve
the file list and the intent router design before you implement.
