import type { TrackAnalysis } from '../../audio/analysis';
import type { Hit } from '../../audio/driver';
import type { Difficulty } from '../common';
import type { EffectSettings, GameEngine, GameInput } from '../types';
import { buildChart } from './chart';
import { GameRenderer } from './render';
import { GameSim } from './sim';

/** Bullet hell: dodge patterns fired from emitters on the beat. */
export class BulletGame implements GameEngine {
  private sim: GameSim;
  private renderer = new GameRenderer();
  readonly duration: number;
  readonly health = null;

  constructor(analysis: TrackAnalysis, difficulty: Difficulty) {
    this.sim = new GameSim(buildChart(analysis, difficulty), analysis);
    this.duration = analysis.duration;
  }

  get stats() { return this.sim.stats; }
  get multiplier() { return this.sim.multiplier; }
  get position() { return this.sim.position; }
  get player() { return this.sim.player; }

  resize(w: number, h: number) { this.sim.resize(w, h); }

  reset() {
    this.sim.reset();
    this.renderer.reset();
  }

  step(pos: number, dt: number, input: GameInput, hits: Hit[], fx: EffectSettings) {
    const res = this.sim.step(pos, dt, input);
    this.renderer.update(this.sim, res, hits, dt, fx);
  }

  draw(canvas: HTMLCanvasElement, fx: EffectSettings) { this.renderer.draw(canvas, this.sim, fx); }

  takeRewind() { return null; }
}
