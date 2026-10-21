import { useRef, useImperativeHandle, forwardRef, useEffect, useMemo, useState } from 'react';
import type { TrackAnalysis } from '../audio/analysis';
import { TypingDriver, type DriverParams } from '../audio/driver';
import type { Difficulty } from '../game/common';
import type { EffectSettings, GameEngine, GameInput, GameStyle } from '../game/types';
import { BulletGame } from '../game/bullets';
import { ShapesGame } from '../game/shapes';
import { WaveGame } from '../game/wave';
import styles from '../styles/Game.module.css';

export interface GameHandle {
  /** Advances the game to the audible position and draws it. */
  frame: (pos: number, dt: number) => void;
  /** The song ended: show the results. */
  finish: () => void;
  /** Playback is starting; begins a new run if the last one finished. */
  start: () => void;
}

interface GameProps {
  analysis: TrackAnalysis | null;
  trackName: string;
  status: string | null;
  isPlaying: boolean;
  style: GameStyle;
  difficulty: Difficulty;
  screenshake: boolean;
  screenshakeMultiplier: number;
  shakeThreshold: number;
  glowIntensity: number;
  onStyleChange: (style: GameStyle) => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  /** Rewinds the song (checkpoints). */
  onSeek: (seconds: number) => void;
}

interface Results {
  score: number;
  hits: number;
  grazes: number;
  deaths: number;
  maxMult: number;
  grade: string;
  best: number | null;
  newBest: boolean;
  practice: boolean;
}

const SCORES_KEY = 'sound-typer-scores';
// Only used for hit detection, the typing speed doesn't matter here
const HIT_PARAMS: DriverParams = { maxCps: 0, dynamics: 1, punch: 0 };
const TAP_MS = 200;
const MOUSE_TAKEOVER_PX = 12;

const KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
};
const DASH_KEYS = new Set(['Space', 'KeyX', 'KeyK', 'KeyJ', 'ShiftLeft', 'ShiftRight']);
const HOLD_KEYS = new Set([...DASH_KEYS, 'ArrowUp', 'KeyW']);

const STYLE_OPTIONS: { value: GameStyle; label: string }[] = [
  { value: 'bullets', label: 'Bullet hell' },
  { value: 'shapes', label: 'Shapes' },
  { value: 'wave', label: 'Wave' },
];

function loadScores(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCORES_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function gradeFor(hits: number, deaths: number, minutes: number) {
  const perMin = hits / Math.max(0.5, minutes);
  if (deaths >= 3) return 'D';
  // Dying caps the grade, however clean the rest was
  if (hits === 0) return 'S';
  if (perMin <= 1 && deaths === 0) return 'A';
  if (perMin <= 3) return 'B';
  if (perMin <= 6) return 'C';
  return 'D';
}

function createEngine(style: GameStyle, analysis: TrackAnalysis, difficulty: Difficulty): GameEngine {
  if (style === 'shapes') return new ShapesGame(analysis, difficulty);
  if (style === 'wave') return new WaveGame(analysis, difficulty);
  return new BulletGame(analysis, difficulty);
}

export const Game = forwardRef<GameHandle, GameProps>(({
  analysis, trackName, status, isPlaying, style, difficulty, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity,
  onStyleChange, onTogglePlay, onRestart, onSeek,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scoreRef = useRef<HTMLSpanElement>(null);
  const multRef = useRef<HTMLSpanElement>(null);
  const hitsRef = useRef<HTMLSpanElement>(null);
  const healthRef = useRef<HTMLSpanElement>(null);
  const keysRef = useRef(new Set<string>());
  const dashRef = useRef(false);
  const pointerRef = useRef<{
    target: [number, number] | null;
    offset: [number, number] | null;
    pressed: boolean;
    touches: number;
    downAt: number;
    /** Last mouse position seen, in client pixels. */
    client: [number, number] | null;
    /** Where the mouse was when the keyboard took over; null while the mouse steers. */
    keyboardAt: [number, number] | null;
  }>({ target: null, offset: null, pressed: false, touches: 0, downAt: 0, client: null, keyboardAt: null });
  const finishedRef = useRef(false);
  const [results, setResults] = useState<Results | null>(null);
  const [practice, setPractice] = useState(false);

  const engine = useMemo(() => (analysis ? createEngine(style, analysis, difficulty) : null), [analysis, style, difficulty]);
  const hitDriver = useMemo(() => (analysis ? new TypingDriver(analysis) : null), [analysis]);

  // New engine: clear the previous run's overlays (the effect below resets the engine itself)
  const [prevEngine, setPrevEngine] = useState(engine);
  if (engine !== prevEngine) {
    setPrevEngine(engine);
    setResults(null);
    setPractice(false);
  }

  const fxRef = useRef<EffectSettings>({ screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, focus: false });
  const propsRef = useRef({ engine, trackName, style, difficulty, isPlaying, onTogglePlay, onSeek });
  useEffect(() => {
    fxRef.current = { ...fxRef.current, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity };
    propsRef.current = { engine, trackName, style, difficulty, isPlaying, onTogglePlay, onSeek };
  });

  const toWorld = (clientX: number, clientY: number): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas || !propsRef.current.engine) return null;
    const rect = canvas.getBoundingClientRect();
    const u = Math.min(rect.width, rect.height) / 100;
    return [(clientX - rect.left) / u, (clientY - rect.top) / u];
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    const e = propsRef.current.engine;
    if (canvas && e) e.draw(canvas, fxRef.current);
  };

  const updateHud = () => {
    const e = propsRef.current.engine;
    if (!e) return;
    if (scoreRef.current) scoreRef.current.textContent = Math.floor(e.stats.score).toLocaleString();
    if (multRef.current) multRef.current.textContent = `×${e.multiplier}`;
    if (hitsRef.current) hitsRef.current.textContent = String(e.stats.hits);
    if (healthRef.current && e.health) {
      healthRef.current.textContent = '■'.repeat(Math.max(0, e.health.hp)) + '□'.repeat(Math.max(0, e.health.max - e.health.hp));
    }
  };

  // New engine: fresh run
  useEffect(() => {
    finishedRef.current = false;
    const canvas = canvasRef.current;
    if (engine && canvas) {
      engine.resize(canvas.clientWidth, canvas.clientHeight);
      engine.reset();
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
    const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const onDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const p = propsRef.current;
      const shapes = p.style === 'shapes';
      if (e.code === 'Space') {
        e.preventDefault();
        // Otherwise a focused button would also get "clicked" by the space key
        (document.activeElement as HTMLElement | null)?.blur();
      }
      if (e.code === 'KeyP' || (e.code === 'Escape' && !document.querySelector('[aria-modal="true"]'))) {
        if (p.isPlaying && !e.repeat) p.onTogglePlay();
        return;
      }
      // Space dashes in Shapes while playing, otherwise it's play/pause
      if (shapes && p.isPlaying && DASH_KEYS.has(e.code)) {
        if (!e.repeat) dashRef.current = true;
        return;
      }
      // The wave flies up while one of these is held
      if (p.style === 'wave' && p.isPlaying && HOLD_KEYS.has(e.code)) {
        e.preventDefault();
        keysRef.current.add(e.code);
        return;
      }
      if (e.code === 'Space') {
        if (!e.repeat) p.onTogglePlay();
        return;
      }
      if (KEYS[e.code] || e.key === 'Shift') {
        keysRef.current.add(e.code);
        if (KEYS[e.code]) {
          e.preventDefault();
          // The keyboard takes over until the mouse is moved away from where it rests, otherwise
          // the cursor would pull the player back the moment the keys are released
          const ptr = pointerRef.current;
          if (ptr.offset === null) {
            ptr.target = null;
            // Position unknown yet: the next mouse event marks where it rests
            ptr.keyboardAt = ptr.client ?? [NaN, NaN];
          }
        }
      }
    };
    const onUp = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    const onBlur = () => keysRef.current.clear();
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const readInput = (): GameInput => {
    const keys = keysRef.current;
    let dx = 0, dy = 0;
    for (const code of keys) {
      const k = KEYS[code];
      if (k) { dx += k[0]; dy += k[1]; }
    }
    const p = pointerRef.current;
    const style = propsRef.current.style;
    const focus = style === 'bullets' && (keys.has('ShiftLeft') || keys.has('ShiftRight') || p.pressed);
    const dash = dashRef.current;
    dashRef.current = false;
    let hold = p.pressed || p.touches > 0;
    for (const code of keys) if (HOLD_KEYS.has(code)) hold = true;
    return { dx: Math.sign(dx), dy: Math.sign(dy), focus, target: p.target, dash, hold };
  };

  useImperativeHandle(ref, () => ({
    frame(pos: number, dt: number) {
      const e = propsRef.current.engine;
      // Frames can still arrive between the song ending and playback stopping
      if (!e || finishedRef.current) return;
      const input = readInput();
      fxRef.current.focus = input.focus;
      const hits = hitDriver?.step(pos, dt, HIT_PARAMS).hits ?? [];
      e.step(pos, dt, input, hits, fxRef.current);
      const rewind = e.takeRewind();
      if (rewind !== null) propsRef.current.onSeek(rewind);
      redraw();
      updateHud();
      if (e.stats.practice !== practice) setPractice(e.stats.practice);
    },

    start() {
      const e = propsRef.current.engine;
      if (!e || !finishedRef.current) return;
      finishedRef.current = false;
      e.reset();
      setResults(null);
    },

    finish() {
      const { engine: e, trackName: name, difficulty: diff, style: st } = propsRef.current;
      if (!e || finishedRef.current) return;
      finishedRef.current = true;
      const s = e.stats;
      const score = Math.floor(s.score);
      // Bullet hell keeps the original key so earlier best scores still count
      const key = st === 'bullets' ? `${name}|${diff}` : `${name}|${diff}|${st}`;
      const scores = loadScores();
      const best = scores[key] ?? null;
      const newBest = !s.practice && (best === null || score > best);
      if (newBest) {
        scores[key] = score;
        try { localStorage.setItem(SCORES_KEY, JSON.stringify(scores)); } catch { /* storage full or blocked */ }
      }
      setResults({
        score, hits: s.hits, grazes: s.grazes, deaths: s.deaths, maxMult: s.maxMult,
        grade: gradeFor(s.hits, s.deaths, e.duration / 60),
        best, newBest, practice: s.practice,
      });
    },
  }));

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointerRef.current;
    const w = toWorld(e.clientX, e.clientY);
    if (!w) return;
    if (e.pointerType === 'mouse') {
      p.client = [e.clientX, e.clientY];
      // Browsers report moves for a resting cursor too (sensor jitter, layout changes, bogus
      // movementX), so the mouse only takes back control once it's clearly been moved
      if (p.keyboardAt) {
        if (Number.isNaN(p.keyboardAt[0])) { p.keyboardAt = [e.clientX, e.clientY]; return; }
        if (Math.hypot(e.clientX - p.keyboardAt[0], e.clientY - p.keyboardAt[1]) < MOUSE_TAKEOVER_PX) return;
        p.keyboardAt = null;
      }
      p.target = w;
    } else if (p.offset && e.isPrimary) {
      // Touch steers relative to where the finger went down, so it doesn't cover the player
      p.target = [w[0] + p.offset[0], w[1] + p.offset[1]];
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = pointerRef.current;
    const eng = propsRef.current.engine;
    const shapes = propsRef.current.style === 'shapes';
    const w = toWorld(e.clientX, e.clientY);
    if (e.pointerType === 'mouse') {
      p.client = [e.clientX, e.clientY];
      if (e.button === 0) {
        if (shapes) dashRef.current = true;
        else p.pressed = true;
      }
      // Clicking to dash shouldn't hand steering back to the mouse
      if (w && !(shapes && p.keyboardAt)) {
        p.target = w;
        p.keyboardAt = null;
      }
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    p.touches++;
    // A second finger dashes
    if (!e.isPrimary) {
      if (shapes) dashRef.current = true;
      return;
    }
    p.downAt = performance.now();
    if (eng && w) {
      p.offset = [eng.player.x - w[0], eng.player.y - w[1]];
      p.target = [eng.player.x, eng.player.y];
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = pointerRef.current;
    if (e.pointerType === 'mouse') {
      p.pressed = false;
      return;
    }
    p.touches = Math.max(0, p.touches - 1);
    if (!e.isPrimary) return;
    // A quick tap dashes too
    if (propsRef.current.style === 'shapes' && performance.now() - p.downAt < TAP_MS) dashRef.current = true;
    p.offset = null;
    p.target = null;
  };

  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    pointerRef.current.target = null;
    pointerRef.current.pressed = false;
  };

  const shapes = style === 'shapes';
  const wave = style === 'wave';
  const bullets = style === 'bullets';
  let message: string | null = null;
  if (!analysis) message = status ?? 'Load a song to play';
  else if (!isPlaying && !results) message = (engine?.position ?? 0) > 0.05 ? 'Paused' : 'Ready';

  return (
    <div className={`${styles.outer} ${isPlaying ? styles.playing : ''}`}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div className={styles.hud}>
        {!bullets && (
          <div className={styles.stat}>
            <span className={styles.statLabel}>Health</span>
            <span ref={healthRef} className={`${styles.statValue} ${styles.health}`} />
          </div>
        )}
        <div className={styles.stat}>
          <span className={styles.statLabel}>Score</span>
          <span ref={scoreRef} className={styles.statValue}>0</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Combo</span>
          <span ref={multRef} className={styles.statValue}>×1</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Hits</span>
          <span ref={hitsRef} className={styles.statValue}>0</span>
        </div>
        {practice && <span className={styles.practice}>Practice</span>}
      </div>

      {message && (
        <div className={styles.overlay}>
          <div className={styles.card}>
            <div className={styles.title}>{message}</div>
            {analysis && (
              <>
                {message === 'Ready' && (
                  <div className={styles.segmented} role="group" aria-label="Game style">
                    {STYLE_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        className={`${styles.segBtn} ${style === o.value ? styles.segBtnActive : ''}`}
                        aria-pressed={style === o.value}
                        onClick={() => onStyleChange(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
                <button className={styles.primaryBtn} onClick={onTogglePlay}>
                  {message === 'Paused' ? 'Resume' : 'Start'}
                </button>
                {wave ? (
                  <div className={styles.help}>
                    <span>Hold <kbd>Space</kbd> / <kbd>W</kbd> / <kbd>Up</kbd> / click to fly up, let go to fly down</span>
                    <span>Touch: hold anywhere</span>
                    <span><kbd>Esc</kbd> / <kbd>P</kbd> pause</span>
                    <span>The level turns on the beat. Floor and ceiling are safe unless spiked; orbs on the turns score extra. Run out of health and the song rewinds to the last checkpoint.</span>
                  </div>
                ) : shapes ? (
                  <div className={styles.help}>
                    <span><kbd>Mouse</kbd> / <kbd>WASD</kbd> / <kbd>Arrows</kbd> move</span>
                    <span><kbd>Space</kbd> / <kbd>Shift</kbd> / <kbd>X</kbd> / click: dash (invulnerable while dashing)</span>
                    <span>Touch: drag to move, tap or second finger to dash</span>
                    <span><kbd>Esc</kbd> / <kbd>P</kbd> pause</span>
                    <span>Faint shapes turn solid on the beat. Run out of health and the song rewinds to the last checkpoint.</span>
                  </div>
                ) : (
                  <div className={styles.help}>
                    <span><kbd>Mouse</kbd> / <kbd>WASD</kbd> / <kbd>Arrows</kbd> move</span>
                    <span><kbd>Shift</kbd> or hold click: slow, precise movement</span>
                    <span>Touch: drag anywhere</span>
                    <span><kbd>Space</kbd> / <kbd>Esc</kbd> / <kbd>P</kbd> pause</span>
                    <span>Dodge everything. Only the white dot is your hitbox. Brushing past bullets (grazing) scores extra.</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {results && (
        <div className={styles.overlay}>
          <div className={styles.card}>
            <div className={styles.grade}>{results.grade}</div>
            <div className={styles.score}>{results.score.toLocaleString()}</div>
            {results.practice ? (
              <div className={styles.note}>Practice run (seeked), not counted for best score</div>
            ) : results.newBest ? (
              <div className={styles.note}>New best!</div>
            ) : (
              results.best !== null && <div className={styles.note}>Best: {results.best.toLocaleString()}</div>
            )}
            <div className={styles.resultRows}>
              <span>Hits taken</span><span>{results.hits}</span>
              {!bullets && <><span>Rewinds</span><span>{results.deaths}</span></>}
              <span>{shapes ? 'Dash dodges' : wave ? 'Orbs' : 'Grazes'}</span><span>{results.grazes}</span>
              <span>Max combo</span><span>×{results.maxMult}</span>
            </div>
            <button className={styles.primaryBtn} onClick={onRestart}>Play again</button>
          </div>
        </div>
      )}
    </div>
  );
});
