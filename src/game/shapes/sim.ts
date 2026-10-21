import type { TrackAnalysis } from '../../audio/analysis';
import { intensityAt, sample } from '../common';
import { newStats, type GameInput, type RunStats } from '../types';
import { distanceTo, geometry, PLAYER_SPEED, type ArenaInfo, type Hazard, type ShapesChart } from './chart';

export const PLAYER_SIZE = 2.6;
const PLAYER_RADIUS = 1.0;
const POINTER_SPEED = 90;
const DASH_TIME = 0.15;
const DASH_SPEED = 190;
/** Invulnerability after the dash itself, so threading through a bar isn't frame perfect. */
const DASH_GRACE = 0.05;
const INVULN = 1.5;
const REWIND_GRACE = 2;
const MAX_CATCHUP = 0.25;
const COMBO_STEP = 5;
const MAX_MULT = 8;

export interface ShapesStep {
  hit: boolean;
  /** Health ran out; the song is about to rewind. */
  died: boolean;
  /** Hazards dashed through this frame. */
  dodges: number;
  dashed: boolean;
  checkpoint: boolean;
  rewound: boolean;
}

export class ShapesSim {
  readonly chart: ShapesChart;
  private analysis: TrackAnalysis;
  private cursor = 0;
  private lastPos = -1;
  private pendingRewind: number | null = null;
  private expectRewind: number | null = null;
  private dodged = new Set<number>();

  width = 100;
  height = 100;
  active: Hazard[] = [];
  arena: ArenaInfo = { w: 100, h: 100, targets: new Map() };
  player = { x: 50, y: 70, invuln: 0, dash: 0, cooldown: 0, dirX: 0, dirY: -1, vx: 0, vy: 0 };
  hp: number;
  stats: RunStats = newStats();
  position = 0;

  constructor(chart: ShapesChart, analysis: TrackAnalysis) {
    this.chart = chart;
    this.analysis = analysis;
    this.hp = chart.maxHp;
  }

  get multiplier() {
    return Math.min(MAX_MULT, 1 + Math.floor(this.stats.combo / COMBO_STEP));
  }

  get dashing() {
    return this.player.dash > 0;
  }

  /** Total cooldown of one dash, as `player.cooldown` counts it down. */
  get dashRecharge() {
    return DASH_TIME + this.chart.dashCooldown;
  }

  resize(w: number, h: number) {
    const k = 100 / Math.max(1, Math.min(w, h));
    const nw = w * k, nh = h * k;
    this.player.x = (this.player.x / this.width) * nw;
    this.player.y = (this.player.y / this.height) * nh;
    this.width = this.arena.w = nw;
    this.height = this.arena.h = nh;
  }

  reset() {
    this.active = [];
    this.arena.targets.clear();
    this.dodged.clear();
    this.player = { x: this.width / 2, y: this.height * 0.7, invuln: 0, dash: 0, cooldown: 0, dirX: 0, dirY: -1, vx: 0, vy: 0 };
    this.hp = this.chart.maxHp;
    this.stats = newStats();
    this.lastPos = -1;
    this.position = 0;
    this.cursor = 0;
    this.pendingRewind = null;
    this.expectRewind = null;
  }

  levelAt(t: number) {
    return sample(this.analysis.level, this.analysis.fps, t);
  }

  /** 0..1, the same curve the typewriter's speed follows. */
  intensityAt(t: number) {
    return intensityAt(this.analysis, t);
  }

  takeRewind() {
    const r = this.pendingRewind;
    this.pendingRewind = null;
    return r;
  }

  private lockTarget(hz: Hazard) {
    if ('target' in hz && hz.target) this.arena.targets.set(hz.id, [this.player.x / this.width, this.player.y / this.height]);
  }

  private resync(pos: number) {
    const hz = this.chart.hazards;
    this.arena.targets.clear();
    this.dodged.clear();
    this.active = [];
    let i = 0;
    while (i < hz.length && hz[i].warn <= pos) {
      if (hz[i].end > pos) { this.active.push(hz[i]); this.lockTarget(hz[i]); }
      i++;
    }
    this.cursor = i;
  }

  private movePlayer(dt: number, input: GameInput, res: ShapesStep) {
    const p = this.player;
    let mx = 0, my = 0, speed = PLAYER_SPEED;
    if (input.dx || input.dy) {
      const len = Math.hypot(input.dx, input.dy);
      mx = input.dx / len; my = input.dy / len;
    } else if (input.target) {
      const dx = input.target[0] - p.x, dy = input.target[1] - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) {
        mx = dx / dist; my = dy / dist;
        speed = Math.min(POINTER_SPEED, dist / Math.max(dt, 1e-3));
      }
    }
    if (mx || my) { p.dirX = mx; p.dirY = my; }

    p.cooldown = Math.max(0, p.cooldown - dt);
    if (input.dash && p.cooldown <= 0 && p.dash <= 0) {
      p.dash = DASH_TIME;
      p.cooldown = DASH_TIME + this.chart.dashCooldown;
      res.dashed = true;
    }
    if (p.dash > 0) {
      const d = Math.min(dt, p.dash);
      p.vx = p.dirX * DASH_SPEED;
      p.vy = p.dirY * DASH_SPEED;
      p.x += p.vx * d;
      p.y += p.vy * d;
      p.dash -= dt;
      if (p.dash <= 0) p.invuln = Math.max(p.invuln, DASH_GRACE);
    } else {
      p.vx = mx * speed;
      p.vy = my * speed;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    const m = PLAYER_SIZE / 2;
    p.x = Math.min(this.width - m, Math.max(m, p.x));
    p.y = Math.min(this.height - m, Math.max(m, p.y));
  }

  step(pos: number, dt: number, input: GameInput): ShapesStep {
    const res: ShapesStep = { hit: false, died: false, dodges: 0, dashed: false, checkpoint: false, rewound: false };
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
        this.stats.practice = true;
      }
      this.resync(pos);
      this.lastPos = pos;
      this.position = pos;
      return res;
    }
    // Waiting for the rewind to happen: freeze
    if (this.expectRewind !== null) return res;

    const adv = pos - this.lastPos;
    for (const cp of this.chart.checkpoints) if (cp > 0 && cp > this.lastPos && cp <= pos) res.checkpoint = true;
    this.lastPos = pos;
    this.position = pos;
    const p = this.player;

    this.movePlayer(Math.min(dt, 0.1), input, res);
    p.invuln = Math.max(0, p.invuln - adv);

    const hz = this.chart.hazards;
    while (this.cursor < hz.length && hz[this.cursor].warn <= pos) {
      const h = hz[this.cursor++];
      if (h.end <= pos) continue;
      this.active.push(h);
      this.lockTarget(h);
    }
    this.active = this.active.filter((h) => {
      if (h.end > pos) return true;
      this.arena.targets.delete(h.id);
      this.dodged.delete(h.id);
      return false;
    });

    // ---- Collisions ----
    const safe = p.invuln > 0 || p.dash > 0;
    for (const h of this.active) {
      if (pos < h.hit) continue;
      let touching = false;
      for (const g of geometry(h, pos, this.arena)) {
        if (distanceTo(g, p.x, p.y) < PLAYER_RADIUS) { touching = true; break; }
      }
      if (!touching) continue;
      if (p.dash > 0) {
        if (!this.dodged.has(h.id)) { this.dodged.add(h.id); res.dodges++; }
      } else if (!safe) {
        res.hit = true;
        break;
      }
    }

    const s = this.stats;
    if (res.hit) {
      s.hits++;
      s.combo = 0;
      p.invuln = INVULN;
      this.hp--;
      if (this.hp <= 0) {
        res.died = true;
        s.deaths++;
        this.hp = this.chart.maxHp;
        let cp = 0;
        for (const c of this.chart.checkpoints) if (c <= pos) cp = c;
        this.pendingRewind = cp;
        this.expectRewind = cp;
      }
    } else {
      s.combo += adv;
    }
    const mult = this.multiplier;
    s.maxMult = Math.max(s.maxMult, mult);
    s.grazes += res.dodges;
    s.score += adv * 10 * mult * (0.5 + this.levelAt(pos)) + res.dodges * 40 * mult;
    return res;
  }
}
