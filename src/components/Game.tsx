import { useRef, useImperativeHandle, forwardRef, useEffect, useMemo, useState } from 'react';
import type { TrackAnalysis } from '../audio/analysis';
import { TypingDriver, type DriverParams } from '../audio/driver';
import type { LyricLine } from '../audio/lyrics';
import type { Difficulty } from '../game/common';
import type { EffectSettings, GameEngine, GameInput, GameStyle } from '../game/types';
import { BulletGame } from '../game/bullets';
import { ShapesGame } from '../game/shapes';
import { WaveGame } from '../game/wave';
import { ShieldGame } from '../game/shield';
import styles from '../styles/Game.module.css';
import { Stage, type Session, type StageHandle } from './Stage';

export interface GameHandle {
  /** Advances the game to the audible position and draws it. */
  frame: (pos: number, dt: number) => void;
  /** The song ended: show how the run went. */
  finish: () => void;
  /** Playback is starting; begins a new run if the last one finished. */
  start: () => void;
}

interface GameProps {
  session: Session;
  style: GameStyle;
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
  /** The song's timed lyrics, null if it has none. */
  lyrics: LyricLine[] | null;
  /** 0 to 1; 0 hides them. */
  lyricsOpacity: number;
}

interface Results {
  hits: number;
  deaths: number;
}

// Only used for hit detection, the typing speed doesn't matter here
const HIT_PARAMS: DriverParams = { maxCps: 0, dynamics: 1, punch: 0 };
const NO_INPUT: GameInput = { dx: 0, dy: 0, focus: false, target: null, dash: false, hold: false, facing: null };
const TAP_MS = 200;

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
  session, style, respawnDelay, invincible, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, cameraZoom, partColors, showHealth, lyrics, lyricsOpacity,
}, ref) => {
  const { analysis, isPlaying, difficulty, getPosition, onTogglePlay, onPause, onSeek } = session;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<HTMLSpanElement>(null);
  const lowRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<StageHandle>(null);
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
  const finishedRef = useRef(false);
  const [results, setResults] = useState<Results | null>(null);
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

  const fxRef = useRef<EffectSettings>({ screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, cameraZoom, partColors, showHealth, lyrics, lyricsOpacity, focus: false });
  const propsRef = useRef({ engine, style, respawnDelay, invincible, isPlaying, respawning, getPosition, onTogglePlay, onPause, onSeek });
  useEffect(() => {
    fxRef.current = { ...fxRef.current, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, cameraZoom, partColors, showHealth, lyrics, lyricsOpacity };
    propsRef.current = { engine, style, respawnDelay, invincible, isPlaying, respawning, getPosition, onTogglePlay, onPause, onSeek };
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
    lowRef.current?.toggleAttribute('data-low', fxRef.current.showHealth && e.health?.hp === 1);
    stageRef.current?.update(e.position);
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

  const restart = (from: number) => {
    seekTo(from);
    if (!propsRef.current.isPlaying) propsRef.current.onTogglePlay();
  };

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

  /** The keys the game is played with; everything about the song is the stage's. */
  const onKey = (e: KeyboardEvent) => {
    // The respawn countdown counts as playing, so dashing or flying doesn't resume early
    const live = isPlaying || respawning;
    // Space dashes in Shapes while playing, otherwise it's play/pause
    if (style === 'shapes' && live && DASH_KEYS.has(e.code)) {
      if (!e.repeat) dashRef.current = true;
      return true;
    }
    // The wave flies up while one of these is held
    if (style === 'wave' && live && HOLD_KEYS.has(e.code)) {
      e.preventDefault();
      keysRef.current.add(e.code);
      return true;
    }
    if (style === 'shield' && e.code in KEY_SIDES && !e.repeat) facingRef.current = KEY_SIDES[e.code];
    if (!KEYS[e.code] && e.key !== 'Shift') return false;
    keysRef.current.add(e.code);
    if (KEYS[e.code]) e.preventDefault();
    return true;
  };

  useEffect(() => {
    const keys = keysRef.current;
    const onUp = (e: KeyboardEvent) => keys.delete(e.code);
    const onBlur = () => keys.clear();
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Effect settings show right away
  useEffect(() => {
    if (propsRef.current.isPlaying) return;
    redraw();
    updateHud();
  }, [glowIntensity, cameraZoom, partColors, showHealth, lyrics, lyricsOpacity]);

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

  const live = isPlaying || respawning;

  return (
    <Stage
      ref={stageRef}
      session={session}
      live={live}
      results={results && (style === 'bullets' ? [['Hits taken', results.hits]] : [['Hits taken', results.hits], ['Rewinds', results.deaths]])}
      checkpoints={engine?.checkpoints ?? null}
      pauseAway
      hud={<>Hits <span ref={hitsRef}>0</span></>}
      actions={[
        ...(engine?.checkpoints ? [{ label: 'From checkpoint', onClick: () => restart(lastCheckpoint(engine.position)) }] : []),
        { label: 'Restart song', onClick: () => restart(0) },
      ]}
      onToggle={() => { if (respawning) setRespawnUntil(null); else onTogglePlay(); }}
      onPause={() => { setRespawnUntil(null); onPause(); }}
      onSeek={seekTo}
      onKey={onKey}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div ref={lowRef} className={styles.low} aria-hidden="true" />
      {respawning && (
        <div className={styles.respawn}>
          <div ref={countdownRef} className={styles.countdown}>{Math.ceil(respawnDelay)}</div>
          <div className={styles.respawnLabel}>Respawning</div>
        </div>
      )}
    </Stage>
  );
});
