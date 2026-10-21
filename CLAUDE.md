# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `bun run dev` (Vite)
- **Build:** `bun run build` (tsc + Vite)
- **Lint:** `bun run lint` (ESLint 9 flat config)
- **Preview prod build:** `bun run preview`

## What This Is

Sound Typer is a browser app that plays an audio file and "types" text in sync with the music. Louder audio types faster; detected hits (drums, sudden spikes) burst text in and trigger screenshake. Users can load audio files, customize text sources, and tweak how it feels (speed, dynamics, punch, shake, glow) in the Settings modal; the toolbar holds playback, volume, file pickers and the Type/Game mode toggle.

**Game mode** replaces the typewriter with a procedurally generated rhythm game, in one of three styles: bullet hell (dodge patterns fired on the hits), Shapes (Just Shapes & Beats style: dash through telegraphed shapes that land on the beat, rewind to checkpoints on death) or Wave (Geometry Dash wave: hold to fly up, release to fly down, through a scrolling level that turns on the hits).

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
- **`src/components/Settings.tsx`** — Modal for all tuning: typing feel (`FeelPrefs`, stored in `sound-typer-prefs`), game difficulty, effects and layout (`SettingsState`, stored in `sound-typer-settings`; also holds the current mode), reset to defaults.

Game mode (`src/game/`; everything except the renderers is DOM-free and runnable in Bun). Three styles behind one `GameEngine` interface (`types.ts`), picked by `SettingsState.gameStyle`:
- **`common.ts`** — Seeded RNG (per track, same for every difficulty), section splitting (~6–13 s, snapped to strong hits), sliding per-second budget, shake spring, canvas setup.
- **`bullets/`** — Bullet hell. `chart.ts` schedules patterns from emitters per section: pellets (weak hits), aimed fans (crisp), rings (bassy/strong), telegraphed lasers (strongest), spiral streams in loud sections. `sim.ts` spawns them as the audio position passes, advances bullets by audio time, handles collisions/grazes/score. `render.ts` draws (sprite-cached glowing bullets, charge-up telegraphs).
- **`shapes/`** — Just Shapes & Beats style. `chart.ts` gives each section a theme (field, bars, steps, walls, spinner, rain) and turns hits into hazards that warn, go solid on the beat, then shrink; every hazard's geometry is a pure function of time (`geometry()`), shared by collisions and drawing. Bars across the arena are the main element; small hazards come in predictable patterns (bomb trails, shot volleys), pop-ups are placed apart, and homing is limited to small, spaced-out seekers plus targeted bars (they lock onto the player when the warning starts). Every hazard warns at least long enough to walk out of it (`warnFor`), so a dash is never forced. An idle fallback fills silences longer than `idleMax` when the music has hits. The spawn budget and projectile speeds scale with the music's intensity (`intensityAt` in `common.ts`, the typewriter's curve); no single obstacle covers more than half the arena. The renderer is intensity-driven too (speed streaks, camera punch, bass thump, pumping background). Spinner beams follow a sampled `BeamPath` (drifting pivot, loudness-driven spin, kicks on hits) and big hits fire ray bursts from the pivot. `sim.ts`: movement, dash (invulnerable, cooldown), health, checkpoints; running out of health asks Game to rewind the song (`takeRewind`), which doesn't count as a seek.
- **`wave/`** — Geometry Dash wave. `chart.ts` lays an ideal path at the wave's slope that turns on hits (gap and strength threshold scale with intensity; sliding on the floor/ceiling takes the next hit), sampled at `RATE` per second together with world x (`xs`, scroll speed per section), then builds around it with clearance: tunnels (`top`/`bot` walls, height = `r + 2·vy·window`, so the difficulty's timing window is explicit), looser spiked corridors with saws outside turns or block columns with a gap, mini sections (slope 2), spam sections (turn on every hit). Sections come from the song's structure, not `buildSections`: `songParts` fits the intensity curve with flat parts (DP with a per-part penalty, then merges similar neighbours, boundaries snapped to strong hits), each part gets a speed stage (`SPEED_STAGES`) from its intensity on a song-relative scale, and the busiest intense parts (the drops) go mini; long parts are split only to change obstacles. Walls are filtered so they never close in faster than the wave flies (fair tunnel entrances). The level is static, so seeking needs no replay. `sim.ts` integrates the wave by audio time with sub-steps; a hit puts it back on the path; health/checkpoints/rewinds work like Shapes. `render.ts`: flat zinc look, one color per speed stage, zigzag trail, beat lines, speed portals and meter.
- **`src/components/Game.tsx`** — Canvas + input (keyboard, mouse, touch incl. dash gestures) + HUD + start/pause/results overlays (style picker on the Ready card). Reuses a `TypingDriver` only to get music hits for shake/glow. App calls `frame()` each rAF, `start()` before playback and `finish()` when the song ends.

**Persistence:** Four localStorage keys (`sound-typer-prefs`, `sound-typer-text-source`, `sound-typer-settings`, `sound-typer-scores`) store user preferences, custom text, settings, and best game scores per track + difficulty (+ style).

## Styling

CSS Modules (`*.module.css`) per component, plus `global.css`. Responsive design with media queries for smaller screens.
