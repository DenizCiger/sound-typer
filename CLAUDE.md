# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `bun run dev` (Vite)
- **Build:** `bun run build` (tsc + Vite)
- **Lint:** `bun run lint` (ESLint 9 flat config)
- **Preview prod build:** `bun run preview`

## What This Is

Sound Typer is a browser app that plays an audio file and "types" text in sync with the music's intensity. Louder/more intense audio produces faster typing. Users can load audio files, customize text sources, and tweak parameters (volume, power exponent, speed multiplier).

## Architecture

React 19 + TypeScript + Vite. No router, no state library — single-page app with all state in `App.tsx`.

**Core data flow:** Audio file → Web Audio API (`useAudioEngine`) → `AnalyserNode` frequency data → `useAnimationLoop` (rAF loop) computes intensity → feeds characters to `Typewriter` component via imperative handle (`TypewriterHandle.feed()`).

Key pieces:
- **`src/hooks/useAudioEngine.ts`** — Web Audio API wrapper: load/play/pause/seek, exposes analyser + gain nodes via refs. Uses a Proxy for live duration.
- **`src/hooks/useAnimationLoop.ts`** — requestAnimationFrame loop that reads frequency data, computes power-based intensity, calls `onFrame`.
- **`src/components/Typewriter.tsx`** — Displays typed text, exposed via `forwardRef` with imperative `feed()` method. Supports screenshake, cursor position, and text width settings.
- **`src/components/Controls.tsx`** — Toolbar with audio controls, sliders, drag-and-drop file loading.
- **`src/components/Visualizer.tsx`** — Canvas-based frequency visualizer.
- **`src/components/Settings.tsx`** — Modal for preferences (screenshake, cursor position, text width).

**Persistence:** Three localStorage keys (`sound-typer-prefs`, `sound-typer-text-source`, `sound-typer-settings`) store user preferences, custom text, and settings.

## Styling

CSS Modules (`*.module.css`) per component, plus `global.css`. Responsive design with media queries for smaller screens.
