import { useRef, useImperativeHandle, forwardRef, useEffect, useMemo, useState } from 'react';
import type { TrackAnalysis } from '../audio/analysis';
import { TypingDriver, type DriverParams } from '../audio/driver';
import type { Difficulty } from '../game/common';
import type { EffectSettings, GameEngine, GameInput, GameStyle } from '../game/types';
import { BulletGame } from '../game/bullets';
import { ShapesGame } from '../game/shapes';
import { WaveGame } from '../game/wave';
import { ShieldGame } from '../game/shield';
import { STYLE_OPTIONS } from '../game/options';
import styles from '../styles/Game.module.css';
import { GameMenu } from './GameMenu';
import { SongBar, type SongBarHandle } from './SongBar';

export interface GameHandle {
  /** Advances the game to the audible position and draws it. */
  frame: (pos: number, dt: number) => void;
  /** The song ended: show how the run went. */
  finish: () => void;
  /** Playback is starting; begins a new run if the last one finished. */
  start: () => void;
}

interface GameProps {
  analysis: TrackAnalysis | null;
  status: string | null;
  /** Loading the song failed; `status` says so. */
  failed: boolean;
  trackName: string;
  isPlaying: boolean;
  /** Where playback is, as the app last showed it. */
  playbackPos: number;
  style: GameStyle;
  difficulty: Difficulty;
  /** Seconds to wait on the checkpoint after a rewind before the song resumes. */
  respawnDelay: number;
  /** Testing: nothing hurts. */
  invincible: boolean;
  screenshake: boolean;
  screenshakeMultiplier: number;
  shakeThreshold: number;
  glowIntensity: number;
  cameraZoom: number;
  partColors: boolean;
  /** Health pips at the player and the glow on the last one. */
  showHealth: boolean;
  volume: number;
  showVisualizer: boolean;
  /** The audible position right now. */
  getPosition: () => number;
  onStyleChange: (style: GameStyle) => void;
  onDifficultyChange: (difficulty: Difficulty) => void;
  onVolume: (v: number) => void;
  onToggleVisualizer: () => void;
  onOpenSettings: () => void;
  /** Over to the typewriter. */
  onLeave: () => void;
  onTogglePlay: () => void;
  onPause: () => void;
  onLoadFile: (file: File) => void;
  /** Moves the song (checkpoint rewinds, jumps). */
  onSeek: (seconds: number) => void;
}

interface Results {
  hits: number;
  deaths: number;
}

// Only used for hit detection, the typing speed doesn't matter here
const HIT_PARAMS: DriverParams = { maxCps: 0, dynamics: 1, punch: 0 };
const NO_CHECKPOINTS: readonly number[] = [];
const NO_INPUT: GameInput = { dx: 0, dy: 0, focus: false, target: null, dash: false, hold: false, facing: null };
const TAP_MS = 200;
/** The cursor hides this long after it was last moved while playing. */
const CURSOR_IDLE_MS = 1500;
const TOAST_MS = 1000;
/** Stepping back goes to the checkpoint before if the last one is closer than this, seconds. */
const STEP_BACK_SLACK = 2;
/** How far , and . jump without checkpoints, seconds. */
const STEP_PLAIN = 10;

const KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
};
/** Shield: the side each direction key turns to. */
const KEY_SIDES: Record<string, number> = {
  ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
  KeyW: 0, KeyD: 1, KeyS: 2, KeyA: 3,
};
const DASH_KEYS = new Set(['Space', 'KeyX', 'KeyK', 'KeyJ', 'ShiftLeft', 'ShiftRight']);
const HOLD_KEYS = new Set([...DASH_KEYS, 'ArrowUp', 'KeyW']);

function createEngine(style: GameStyle, analysis: TrackAnalysis, difficulty: Difficulty): GameEngine {
  if (style === 'shapes') return new ShapesGame(analysis, difficulty);
  if (style === 'wave') return new WaveGame(analysis, difficulty);
  if (style === 'shield') return new ShieldGame(analysis, difficulty);
  return new BulletGame(analysis, difficulty);
}

export const Game = forwardRef<GameHandle, GameProps>(({
  analysis, status, failed, trackName, isPlaying, playbackPos, style, difficulty, respawnDelay, invincible, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, cameraZoom, partColors, showHealth, volume, showVisualizer,
  getPosition, onStyleChange, onDifficultyChange, onVolume, onToggleVisualizer, onOpenSettings, onLeave, onTogglePlay, onPause, onSeek, onLoadFile,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<HTMLSpanElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const songBarRef = useRef<SongBarHandle>(null);
  const keysRef = useRef(new Set<string>());
  const dashRef = useRef(false);
  const facingRef = useRef<number | null>(null);
  const touchRef = useRef<{
    target: [number, number] | null;
    /** From the first finger to the player, so it steers relative to where it went down. */
    offset: [number, number] | null;
    touches: number;
    downAt: number;
  }>({ target: null, offset: null, touches: 0, downAt: 0 });
  const cursorTimerRef = useRef(0);
  const toastTimerRef = useRef(0);
  const unmutedRef = useRef(0.1);
  const leavingFullscreenRef = useRef(false);
  const finishedRef = useRef(false);
  const [results, setResults] = useState<Results | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** performance.now() when the respawn countdown ends and the song resumes; null when not respawning. */
  const [respawnUntil, setRespawnUntil] = useState<number | null>(null);
  const countdownRef = useRef<HTMLDivElement>(null);

  const engine = useMemo(() => (analysis ? createEngine(style, analysis, difficulty) : null), [analysis, style, difficulty]);
  const hitDriver = useMemo(() => (analysis ? new TypingDriver(analysis) : null), [analysis]);

  // New engine: clear the previous run's overlays (the effect below resets the engine itself)
  const [prevEngine, setPrevEngine] = useState(engine);
  if (engine !== prevEngine) {
    setPrevEngine(engine);
    setResults(null);
    setRespawnUntil(null);
  }
  // Resumed by hand during the countdown
  if (isPlaying && respawnUntil !== null) setRespawnUntil(null);
  const respawning = respawnUntil !== null;

  const fxRef = useRef<EffectSettings>({ screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, cameraZoom, partColors, showHealth, focus: false });
  const propsRef = useRef({ engine, style, respawnDelay, invincible, isPlaying, respawning, volume, getPosition, onStyleChange, onVolume, onTogglePlay, onPause, onSeek });
  useEffect(() => {
    fxRef.current = { ...fxRef.current, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, cameraZoom, partColors, showHealth };
    propsRef.current = { engine, style, respawnDelay, invincible, isPlaying, respawning, volume, getPosition, onStyleChange, onVolume, onTogglePlay, onPause, onSeek };
  });

  const toWorld = (clientX: number, clientY: number): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas || !propsRef.current.engine) return null;
    const rect = canvas.getBoundingClientRect();
    const u = Math.min(rect.width, rect.height) / 100;
    // The camera fits the play area, which is scaled around the middle of the screen
    const s = propsRef.current.engine.scale;
    const cx = rect.width / 2, cy = rect.height / 2;
    return [(cx + (clientX - rect.left - cx) * s) / u, (cy + (clientY - rect.top - cy) * s) / u];
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    const e = propsRef.current.engine;
    if (canvas && e) e.draw(canvas, fxRef.current);
  };

  const updateHud = () => {
    const e = propsRef.current.engine;
    if (!e) return;
    if (hitsRef.current) hitsRef.current.textContent = String(e.stats.hits);
    outerRef.current?.toggleAttribute('data-low', fxRef.current.showHealth && e.health?.hp === 1);
    songBarRef.current?.update(e.position);
  };

  /** The player picks another place in the song. */
  const seekTo = (t: number) => {
    const p = propsRef.current;
    const e = p.engine;
    if (!e) return;
    if (finishedRef.current) {
      finishedRef.current = false;
      setResults(null);
      e.reset();
    }
    if (t < 0.05) e.reset();
    else e.jump();
    e.step(t, 0, NO_INPUT, [], fxRef.current);
    p.onSeek(t);
    redraw();
    updateHud();
  };

  const lastCheckpoint = (pos: number) => (propsRef.current.engine?.checkpoints ?? []).reduce((best, c) => (c <= pos ? c : best), 0);

  /** To the previous (-1) or next (1) checkpoint, or a few seconds where there are none. */
  const seekStep = (dir: -1 | 1) => {
    const e = propsRef.current.engine;
    if (!e) return;
    const pos = e.position;
    if (!e.checkpoints) seekTo(Math.min(e.duration - 0.5, Math.max(0, pos + dir * STEP_PLAIN)));
    else if (dir < 0) seekTo(lastCheckpoint(pos - STEP_BACK_SLACK));
    else {
      const next = e.checkpoints.find((c) => c > pos + 0.05);
      if (next !== undefined) seekTo(next);
    }
  };

  const restart = (from: number) => {
    seekTo(from);
    if (!propsRef.current.isPlaying) propsRef.current.onTogglePlay();
  };

  const setVolume = (v: number) => {
    const clamped = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
    propsRef.current.onVolume(clamped);
    setToast(clamped > 0 ? `Volume ${Math.round(clamped * 100)}%` : 'Muted');
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  };
  // Finer steps where it's quiet: a few percent there are as much as a lot further up
  const stepVolume = (dir: number) => {
    const v = propsRef.current.volume;
    setVolume(v + dir * (v + dir * 0.005 < 0.2 ? 0.01 : 0.05));
  };
  const toggleMute = () => {
    const v = propsRef.current.volume;
    if (v > 0) unmutedRef.current = v;
    setVolume(v > 0 ? 0 : unmutedRef.current);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      leavingFullscreenRef.current = true;
      document.exitFullscreen().catch(() => {});
      return;
    }
    document.documentElement.requestFullscreen().then(() => {
      // Where supported, Esc keeps pausing in fullscreen (hold it to leave)
      const keyboard = (navigator as { keyboard?: { lock?: (keys: string[]) => Promise<void> } }).keyboard;
      keyboard?.lock?.(['Escape']).catch(() => {});
    }).catch(() => {});
  };

  // Always the latest, for the listeners below that are added once
  const actionsRef = useRef({ seekStep, stepVolume, toggleMute, toggleFullscreen });
  useEffect(() => {
    actionsRef.current = { seekStep, stepVolume, toggleMute, toggleFullscreen };
  });

  // New engine: fresh run
  useEffect(() => {
    finishedRef.current = false;
    const canvas = canvasRef.current;
    if (engine && canvas) {
      engine.resize(canvas.clientWidth, canvas.clientHeight);
      engine.reset();
      // Switched styles in the middle of the song: go on from there
      const pos = propsRef.current.getPosition();
      engine.step(pos, 0, NO_INPUT, [], fxRef.current);
    }
    updateHud();
    redraw();
  }, [engine]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      propsRef.current.engine?.resize(canvas.clientWidth, canvas.clientHeight);
      redraw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const p = propsRef.current;
      const actions = actionsRef.current;
      // The settings have the keyboard while they're open
      if (document.querySelector('[aria-modal="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      // The respawn countdown counts as playing, so dashing or flying doesn't resume early
      const live = p.isPlaying || p.respawning;
      const el = e.target instanceof HTMLInputElement ? e.target : null;
      if (e.target instanceof HTMLTextAreaElement || (el && el.type !== 'range')) return;
      // Arrows move a focused slider in the menu
      if (el && !live && e.code.startsWith('Arrow')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        // Otherwise a focused button would also get "clicked" by the space key
        (document.activeElement as HTMLElement | null)?.blur();
      }
      if (e.code === 'KeyP' || e.code === 'Escape') {
        if (e.repeat) return;
        if (p.respawning) setRespawnUntil(null);
        else if (p.isPlaying || (!finishedRef.current && (p.engine?.position ?? 0) > 0.05)) p.onTogglePlay();
        return;
      }
      if (e.key === ',' || e.key === '.') { actions.seekStep(e.key === ',' ? -1 : 1); return; }
      if (e.key === '+' || e.key === '=' || e.key === '-') { actions.stepVolume(e.key === '-' ? -1 : 1); return; }
      if (e.code === 'KeyM') { if (!e.repeat) actions.toggleMute(); return; }
      if (e.code === 'KeyF') { if (!e.repeat) actions.toggleFullscreen(); return; }
      if (!live) {
        const pick = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
        const option = pick && STYLE_OPTIONS[Number(pick[1]) - 1];
        if (option) { p.onStyleChange(option.value); return; }
      }
      // Space dashes in Shapes while playing, otherwise it's play/pause
      if (p.style === 'shapes' && live && DASH_KEYS.has(e.code)) {
        if (!e.repeat) dashRef.current = true;
        return;
      }
      // The wave flies up while one of these is held
      if (p.style === 'wave' && live && HOLD_KEYS.has(e.code)) {
        e.preventDefault();
        keysRef.current.add(e.code);
        return;
      }
      if (e.code === 'Space') {
        if (!e.repeat) p.onTogglePlay();
        return;
      }
      if (p.style === 'shield' && e.code in KEY_SIDES && !e.repeat) facingRef.current = KEY_SIDES[e.code];
      if (KEYS[e.code] || e.key === 'Shift') {
        keysRef.current.add(e.code);
        if (KEYS[e.code]) e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    // Looking elsewhere: the keys don't arrive here any more, so wait
    const pause = () => {
      setRespawnUntil(null);
      propsRef.current.onPause();
    };
    const onBlur = () => {
      keysRef.current.clear();
      pause();
    };
    const onVisibility = () => { if (document.hidden) pause(); };
    // Where Esc can't be kept from leaving fullscreen, it pauses all the same
    const onFullscreen = () => {
      if (document.fullscreenElement) return;
      if (!leavingFullscreenRef.current) pause();
      leavingFullscreenRef.current = false;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, []);

  // Nothing in the menu keeps the focus once the song runs, and effect settings show right away
  useEffect(() => {
    if (isPlaying) (document.activeElement as HTMLElement | null)?.blur();
  }, [isPlaying]);
  useEffect(() => {
    if (propsRef.current.isPlaying) return;
    redraw();
    updateHud();
  }, [glowIntensity, cameraZoom, partColors, showHealth]);

  const readInput = (): GameInput => {
    const keys = keysRef.current;
    let dx = 0, dy = 0;
    for (const code of keys) {
      const k = KEYS[code];
      if (k) { dx += k[0]; dy += k[1]; }
    }
    const touch = touchRef.current;
    const focus = propsRef.current.style === 'bullets' && (keys.has('ShiftLeft') || keys.has('ShiftRight'));
    const dash = dashRef.current;
    dashRef.current = false;
    const facing = facingRef.current;
    facingRef.current = null;
    let hold = touch.touches > 0;
    for (const code of keys) if (HOLD_KEYS.has(code)) hold = true;
    return { dx: Math.sign(dx), dy: Math.sign(dy), focus, target: touch.target, dash, hold, facing };
  };

  // Respawn countdown: the song is paused on the checkpoint; the player can already move
  // (the rewind grace keeps them safe) and the effects keep animating
  useEffect(() => {
    if (respawnUntil === null) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const p = propsRef.current;
      const left = respawnUntil - now;
      if (left <= 0) {
        setRespawnUntil(null);
        if (!p.isPlaying) p.onTogglePlay();
        return;
      }
      if (p.engine) p.engine.step(p.engine.position, Math.max(0, now - last) / 1000, readInput(), [], fxRef.current);
      last = now;
      if (countdownRef.current) countdownRef.current.textContent = String(Math.ceil(left / 1000));
      redraw();
      updateHud();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [respawnUntil]);

  useImperativeHandle(ref, () => ({
    frame(pos: number, dt: number) {
      const e = propsRef.current.engine;
      // Frames can still arrive between the song ending and playback stopping
      if (!e || finishedRef.current) return;
      const input = readInput();
      fxRef.current.focus = input.focus;
      e.invincible = propsRef.current.invincible;
      const hits = hitDriver?.step(pos, dt, HIT_PARAMS).hits ?? [];
      e.step(pos, dt, input, hits, fxRef.current);
      const rewind = e.takeRewind();
      if (rewind !== null) {
        const p = propsRef.current;
        if (p.respawnDelay > 0) {
          // Pause first so the seek lands exactly on the checkpoint, then show it right away
          p.onPause();
          p.onSeek(rewind);
          e.step(rewind, 0, NO_INPUT, [], fxRef.current);
          setRespawnUntil(performance.now() + p.respawnDelay * 1000);
        } else {
          p.onSeek(rewind);
        }
      }
      redraw();
      updateHud();
    },

    start() {
      const e = propsRef.current.engine;
      if (!e || !finishedRef.current) return;
      finishedRef.current = false;
      e.reset();
      setResults(null);
    },

    finish() {
      const e = propsRef.current.engine;
      if (!e || finishedRef.current) return;
      finishedRef.current = true;
      setResults({ hits: e.stats.hits, deaths: e.stats.deaths });
    },
  }));

  // ---- Touch: the mouse never plays, it's for the song bar ----
  const onPointerMove = (e: React.PointerEvent) => {
    const p = touchRef.current;
    if (e.pointerType !== 'touch' || !p.offset || !e.isPrimary) return;
    const w = toWorld(e.clientX, e.clientY);
    // Steers relative to where the finger went down, so it doesn't cover the player
    if (w) p.target = [w[0] + p.offset[0], w[1] + p.offset[1]];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const p = touchRef.current;
    const { engine: eng, style } = propsRef.current;
    const w = toWorld(e.clientX, e.clientY);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    p.touches++;
    // The shield turns to wherever a finger is, not relative to where it went down
    if (style === 'shield') {
      if (w) p.target = w;
      if (e.isPrimary) p.offset = [0, 0];
      return;
    }
    // A second finger dashes
    if (!e.isPrimary) {
      if (style === 'shapes') dashRef.current = true;
      return;
    }
    p.downAt = performance.now();
    if (eng && w) {
      p.offset = [eng.player.x - w[0], eng.player.y - w[1]];
      p.target = [eng.player.x, eng.player.y];
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const p = touchRef.current;
    p.touches = Math.max(0, p.touches - 1);
    if (!e.isPrimary) return;
    // A quick tap dashes too
    if (propsRef.current.style === 'shapes' && performance.now() - p.downAt < TAP_MS) dashRef.current = true;
    p.offset = null;
    p.target = null;
  };

  // The cursor is only there while it's being moved
  const showCursor = (e: React.PointerEvent) => {
    const outer = outerRef.current;
    if (e.pointerType !== 'mouse' || !outer) return;
    outer.setAttribute('data-cursor', '');
    clearTimeout(cursorTimerRef.current);
    cursorTimerRef.current = window.setTimeout(() => outer.removeAttribute('data-cursor'), CURSOR_IDLE_MS);
  };

  const hasCheckpoints = style !== 'bullets';
  const live = isPlaying || respawning;
  const underway = !results && playbackPos > 0.05;
  const title = !analysis ? status ?? 'Load a song to play' : results ? 'Song complete' : underway ? 'Paused' : 'Ready';

  return (
    <div ref={outerRef} className={`${styles.outer} ${live ? styles.playing : ''}`} onPointerMove={showCursor}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => { if (e.deltaY) stepVolume(e.deltaY < 0 ? 1 : -1); }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className={styles.low} aria-hidden="true" />

      {engine && (
        <div className={styles.hits}>
          Hits <span ref={hitsRef}>0</span>
        </div>
      )}

      {analysis && engine && (
        <SongBar
          ref={songBarRef}
          analysis={analysis}
          checkpoints={engine.checkpoints ?? NO_CHECKPOINTS}
          isPlaying={isPlaying}
          open={!live}
          onTogglePlay={() => { if (respawning) setRespawnUntil(null); else onTogglePlay(); }}
          onSeek={seekTo}
          onScrub={setScrubbing}
        />
      )}

      {respawning && (
        <div className={styles.respawn}>
          <div ref={countdownRef} className={styles.countdown}>{Math.ceil(respawnDelay)}</div>
          <div className={styles.respawnLabel}>Respawning</div>
        </div>
      )}

      {/* Out of the way while the playhead is dragged, to see where it goes */}
      {!live && !scrubbing && (
        <GameMenu
          title={title}
          trackName={trackName}
          loaded={!!analysis}
          busy={status !== null && !failed}
          primary={results ? 'Play again' : underway ? 'Resume' : 'Start'}
          underway={underway}
          hasCheckpoints={hasCheckpoints}
          results={results}
          style={style}
          difficulty={difficulty}
          volume={volume}
          showVisualizer={showVisualizer}
          onPrimary={onTogglePlay}
          onRestart={() => restart(0)}
          onCheckpoint={() => restart(lastCheckpoint(engine?.position ?? 0))}
          onStyleChange={onStyleChange}
          onDifficultyChange={onDifficultyChange}
          onVolume={onVolume}
          onToggleMute={toggleMute}
          onLoadFile={onLoadFile}
          onToggleVisualizer={onToggleVisualizer}
          onFullscreen={toggleFullscreen}
          onOpenSettings={onOpenSettings}
          onLeave={onLeave}
        />
      )}

      {toast && <div className={styles.toast} role="status">{toast}</div>}
    </div>
  );
});
