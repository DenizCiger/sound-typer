# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `bun run dev` (Vite)
- **Build:** `bun run build` (tsc + Vite)
- **Lint:** `bun run lint` (ESLint 9 flat config)
- **Preview prod build:** `bun run preview`

## What This Is

Sound Typer is a browser app that plays an audio file and "types" text in sync with the music. Louder audio types faster; detected hits (drums, sudden spikes) burst text in and trigger screenshake. Users can load audio files, customize text sources, and tweak how it feels (speed, dynamics, punch, shake, glow) in the Settings modal; the toolbar only holds playback, volume and file pickers.

## Architecture

React 19 + TypeScript + Vite. No router, no state library — single-page app with all state in `App.tsx`.

**Core data flow:** Audio file → decoded `AudioBuffer` → offline analysis in a Web Worker (`TrackAnalysis`: loudness curve, activity, timestamped hits with strength) → each rAF frame, `TypingDriver.step(audiblePosition, dt)` turns the analysis into flow chars + burst chars + hits → `Typewriter.feed()` types and applies shake/glow; `Visualizer.draw()` renders spectrum + timeline.

Key pieces:
- **`src/audio/analysis.ts`** — Pure offline analysis (no DOM; runnable in Bun for testing). STFT → K-weighted loudness normalized per track; SuperFlux-style onset detection on a semitone filterbank with centered adaptive threshold, post-hit masking; hit strength = flux rank OR loudness surprise.
- **`src/audio/analyzeBuffer.ts`** / **`analysis.worker.ts`** — Downmix/resample to 22.05 kHz mono via `OfflineAudioContext`, run analysis in a worker.
- **`src/audio/driver.ts`** — `TypingDriver`: time-based (framerate independent) typing from the analysis; handles seeks by resyncing the hit cursor.
- **`src/hooks/useAudioEngine.ts`** — Web Audio API wrapper: load/play/pause/seek/volume. `getPosition()` returns the *audible* position (output latency compensated via `getOutputTimestamp`).
- **`src/hooks/useAnimationLoop.ts`** — rAF loop calling `onFrame(dt)`.
- **`src/components/Typewriter.tsx`** — Displays typed text via imperative `feed(frame, dt)`. Spring-physics screenshake, hit glow (`--hit` CSS var), word snapping on strong hits.
- **`src/components/Controls.tsx`** — Toolbar: file chips (drag-and-drop), transport, volume. Wraps to two rows below 768px.
- **`src/components/Visualizer.tsx`** — Canvas: log-frequency spectrum + scrolling timeline of intensity and hits.
- **`src/components/Settings.tsx`** — Modal for all tuning: typing feel (`FeelPrefs`, stored in `sound-typer-prefs`), effects and layout (`SettingsState`, stored in `sound-typer-settings`), reset to defaults.

**Persistence:** Three localStorage keys (`sound-typer-prefs`, `sound-typer-text-source`, `sound-typer-settings`) store user preferences, custom text, and settings.

## Styling

CSS Modules (`*.module.css`) per component, plus `global.css`. Responsive design with media queries for smaller screens.
