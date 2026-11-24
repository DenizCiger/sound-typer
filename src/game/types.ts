import type { Hit } from '../audio/driver';

export type GameStyle = 'bullets' | 'shapes' | 'wave' | 'shield';

export interface GameInput {
  /** Keyboard direction, each -1..1. */
  dx: number;
  dy: number;
  /** Slow movement (bullet hell). */
  focus: boolean;
  /** Where a finger steers to in world units, or null. The mouse never steers. */
  target: [number, number] | null;
  /** Dash pressed since the last frame (shapes). */
  dash: boolean;
  /** Fly up (wave). */
  hold: boolean;
  /** Side pressed since the last frame (shield): 0 up, 1 right, 2 down, 3 left. */
  facing: number | null;
}

export interface RunStats {
  hits: number;
  /** Times health ran out and the song rewound to a checkpoint. */
  deaths: number;
}

export const newStats = (): RunStats => ({ hits: 0, deaths: 0 });

export interface EffectSettings {
  screenshake: boolean;
  screenshakeMultiplier: number;
  shakeThreshold: number;
  glowIntensity: number;
  /** How much the play area grows and shrinks with the music; 0 keeps it still. */
  cameraZoom: number;
  /** Shapes: each part of the song gets its own hazard colour; off keeps them pink. */
  partColors: boolean;
  /** Draw the health at the player. */
  showHealth: boolean;
  /** Focus held: draw the hitbox brighter. */
  focus: boolean;
}

/**
 * One game style: simulation plus its renderer. World units: the arena's shorter side is
 * 100 units long. Driven by the audible playback position, so everything stays on the music.
 */
export interface GameEngine {
  readonly stats: RunStats;
  /** Audio position of the last step. */
  readonly position: number;
  readonly duration: number;
  readonly player: { x: number; y: number };
  readonly health: { hp: number; max: number } | null;
  /** Song positions the player rewinds to (starting with 0), for the progress bar; null without checkpoints. */
  readonly checkpoints: readonly number[] | null;
  /**
   * Size of the play area against the screen-filling arena (it grows and shrinks with the music
   * around its centre; the camera always shows exactly the play area). 1 for a fixed arena.
   */
  readonly scale: number;
  resize(w: number, h: number): void;
  /** Back to the start of a fresh run. */
  reset(): void;
  /** The player picked another place in the song: the next step lands there with full health. */
  jump(): void;
  /** Advances the game and its effects. `hits` are the music hits this frame. */
  step(pos: number, dt: number, input: GameInput, hits: Hit[], fx: EffectSettings): void;
  draw(canvas: HTMLCanvasElement, fx: EffectSettings): void;
  /** Position to rewind the song to after a death, once; null otherwise. */
  takeRewind(): number | null;
  /** Testing: nothing hurts. */
  invincible: boolean;
}
