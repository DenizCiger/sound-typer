import type { TrackAnalysis } from '../../audio/analysis';
import { intensityAt, sample } from '../common';
import { newStats, type GameInput, type RunStats } from '../types';
import { lowerBound, MINI_R, PLAYER_R, sampleAt, sectionAt, type WaveChart } from './chart';

const INVULN = 1.2;
const REWIND_GRACE = 2;
const MAX_CATCHUP = 0.25;
const SUBSTEP = 1 / 240;

export interface WaveStep {
  hit: boolean;
  /** Health ran out; the song is about to rewind. */
  died: boolean;
  checkpoint: boolean;
  rewound: boolean;
  /** The run jumped (seek or rewind): the trail should restart. */
  jumped: boolean;
}

export class WaveSim {
  readonly chart: WaveChart;
  private analysis: TrackAnalysis;
  private lastPos = -1;
  private pendingRewind: number | null = null;
  private expectRewind: number | null = null;

  player = { x: 0, y: 50, dir: 1, invuln: 0, mini: false, flip: false, speed: 72, vy: 72 };
  hp: number;
  stats: RunStats = newStats();
  position = 0;

  /** Testing: nothing hurts. */
  invincible = false;

  constructor(chart: WaveChart, analysis: TrackAnalysis) {
    this.chart = chart;
    this.analysis = analysis;
    this.hp = chart.maxHp;
  }

  get radius() {
    return this.player.mini ? MINI_R : PLAYER_R;
  }

  reset() {
    this.hp = this.chart.maxHp;
    this.stats = newStats();
    this.lastPos = -1;
    this.position = 0;
    this.pendingRewind = null;
    this.expectRewind = null;
    this.snap(0);
    this.player.invuln = 0;
  }

  levelAt(t: number) {
    return sample(this.analysis.level, this.analysis.fps, t);
  }

  intensityAt(t: number) {
    return intensityAt(this.analysis, t);
  }


  takeRewind() {
    const r = this.pendingRewind;
    this.pendingRewind = null;
    return r;
  }

  /** Puts the wave back on the ideal path at time t. */
  private snap(t: number) {
    const p = this.player;
    p.x = sampleAt(this.chart.xs, t);
    p.y = sampleAt(this.chart.path, t);
    this.applySection(t);
  }

  private applySection(t: number) {
    const sec = sectionAt(this.chart, t);
    this.player.mini = sec.mini;
    this.player.flip = sec.flip;
    this.player.speed = sec.speed;
    this.player.vy = sec.vy;
  }

  /** Is the wave at (x, y) inside anything solid at time t? */
  private touching(t: number, x: number, y: number, r: number) {
    const c = this.chart;
    if (y - r < sampleAt(c.top, t) || y + r > sampleAt(c.bot, t)) return true;
    for (let i = lowerBound(c.saws, x - 15); i < c.saws.length && c.saws[i].x < x + 15; i++) {
      const s = c.saws[i];
      if (Math.hypot(s.x - x, s.y - y) < s.r + r) return true;
    }
    for (const b of c.blocks) {
      if (b.x1 < x - r || b.x0 > x + r) continue;
      if (y + r > b.y0 && y - r < b.y1) return true;
    }
    return false;
  }

  step(pos: number, _dt: number, input: GameInput): WaveStep {
    const res: WaveStep = { hit: false, died: false, checkpoint: false, rewound: false, jumped: false };
    const jumped = this.lastPos >= 0 && (pos < this.lastPos || pos - this.lastPos > MAX_CATCHUP);
    if (this.lastPos < 0 || jumped) {
      if (this.expectRewind !== null && Math.abs(pos - this.expectRewind) < 0.5) {
        // Our own checkpoint rewind, not a seek
        this.expectRewind = null;
        this.player.invuln = REWIND_GRACE;
        res.rewound = true;
      } else if (jumped && pos < 0.1) {
        this.reset();
      } else if (jumped || pos > 0.5) {
        this.player.invuln = Math.max(this.player.invuln, 0.5);
      }
      this.snap(pos);
      this.lastPos = pos;
      this.position = pos;
      res.jumped = true;
      return res;
    }
    // Waiting for the rewind to happen: freeze
    if (this.expectRewind !== null) return res;

    const c = this.chart;
    const p = this.player;
    const adv = pos - this.lastPos;
    for (const cp of c.checkpoints) if (cp > 0 && cp > this.lastPos && cp <= pos) res.checkpoint = true;

    // Sub-step so turns land where they were pressed and nothing gets skipped over
    const steps = Math.max(1, Math.ceil(adv / SUBSTEP));
    const h = adv / steps;
    for (let k = 1; k <= steps; k++) {
      const t = this.lastPos + h * k;
      this.applySection(t);
      // Flipped gravity: holding flies down
      p.dir = (input.hold ? -1 : 1) * (p.flip ? -1 : 1);
      const r = this.radius;
      p.x = sampleAt(c.xs, t);
      p.y += p.dir * p.vy * h;
      p.invuln = Math.max(0, p.invuln - h);

      if (p.invuln <= 0 && !this.invincible && !res.hit && this.touching(t, p.x, p.y, r)) {
        res.hit = true;
        // Back onto the path, so the wave isn't stuck inside a wall when the grace runs out
        p.y = sampleAt(c.path, t);
        p.invuln = INVULN;
      }
    }
    this.lastPos = pos;
    this.position = pos;

    const s = this.stats;
    if (res.hit) {
      s.hits++;
      this.hp--;
      if (this.hp <= 0) {
        res.died = true;
        s.deaths++;
        this.hp = c.maxHp;
        let cp = 0;
        for (const x of c.checkpoints) if (x <= pos) cp = x;
        this.pendingRewind = cp;
        this.expectRewind = cp;
      }
    }
    return res;
  }
}
