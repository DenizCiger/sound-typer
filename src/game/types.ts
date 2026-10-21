import type { Hit } from '../audio/driver';

export type GameStyle = 'bullets' | 'shapes' | 'wave';

export interface GameInput {
  /** Keyboard direction, each -1..1. */
  dx: number;
  dy: number;
  /** Slow movement (bullet hell). */
  focus: boolean;
  /** Pointer target in world units, or null when the pointer isn't steering. */
  target: [number, number] | null;
  /** Dash pressed since the last frame (shapes). */
  dash: boolean;
  /** Fly up (wave). */
  hold: boolean;
}

export interface RunStats {
  score: number;
  hits: number;
  /** Bullet grazes, or hazards dashed through. */
  grazes: number;
  /** Seconds since the last hit. */
  combo: number;
  maxMult: number;
  /** Times health ran out and the song rewound to a checkpoint. */
  deaths: number;
  /** Set once the run was seeked, so it doesn't count for a best score. */
  practice: boolean;
}

export const newStats = (): RunStats => ({ score: 0, hits: 0, grazes: 0, combo: 0, maxMult: 1, deaths: 0, practice: false });

export interface EffectSettings {
  screenshake: boolean;
  screenshakeMultiplier: number;
  shakeThreshold: number;
  glowIntensity: number;
  /** Focus held: draw the hitbox brighter. */
  focus: boolean;
}

/**
 * One game style: simulation plus its renderer. World units: the arena's shorter side is
 * 100 units long. Driven by the audible playback position, so everything stays on the music.
 */
export interface GameEngine {
  readonly stats: RunStats;
  readonly multiplier: number;
  /** Audio position of the last step. */
  readonly position: number;
  readonly duration: number;
  readonly player: { x: number; y: number };
  readonly health: { hp: number; max: number } | null;
  resize(w: number, h: number): void;
  /** Back to the start of a fresh run. */
  reset(): void;
  /** Advances the game and its effects. `hits` are the music hits this frame. */
  step(pos: number, dt: number, input: GameInput, hits: Hit[], fx: EffectSettings): void;
  draw(canvas: HTMLCanvasElement, fx: EffectSettings): void;
  /** Position to rewind the song to after a death, once; null otherwise. */
  takeRewind(): number | null;
}
