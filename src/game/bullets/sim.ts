import type { TrackAnalysis } from '../../audio/analysis';
import { sectionIndexAt } from '../common';
import { newStats, type GameInput, type RunStats } from '../types';
import { emitterPosition, type Chart, type ChartEvent } from './chart';

/**
 * Game state, advanced by the audible playback position so bullets stay locked to the music
 * (pausing freezes them, frame rate doesn't matter). World units: the arena's shorter side is
 * 100 units long. No DOM; the renderer reads the public state.
 */

export const PLAYER_RADIUS = 0.45;
export const GRAZE_RADIUS = 3.2;
const PLAYER_SPEED = 75;
const FOCUS_SPEED = 32;
const POINTER_SPEED = 170;
const POINTER_FOCUS_SPEED = 65;
const INVULN = 1.6;
const HIT_CLEAR_RADIUS = 20;
const SAFE_SPAWN_RADIUS = 10;
const SECTION_BLEND = 0.8;
const MAX_CATCHUP = 0.25;
const MAX_BULLETS = 1500;
const COMBO_STEP = 5; // seconds without a hit per multiplier step
const MAX_MULT = 8;
const LASER_WIDTH = 3.2;

export interface Bullet {
  x: number;
  y: number;
  angle: number;
  speed: number;
  minSpeed: number;
  decel: number;
  /** Angular velocity, rad/s. */
  curve: number;
  r: number;
  /** 0 ring/stream (neutral), 1 aimed. Only affects colour. */
  aimed: boolean;
  grazed: boolean;
  /** Track time it was fired at. */
  born: number;
}

export interface Laser {
  x: number;
  y: number;
  angle: number;
  fire: number;
  warn: number;
  duration: number;
}

export interface StepResult {
  /** Player got hit this frame. */
  hit: boolean;
  grazes: number;
  /** Where patterns fired this frame (for muzzle flashes), with their size. */
  fired: { x: number; y: number; size: number }[];
  /** Bullets cleared around the player after a hit. */
  popped: { x: number; y: number }[];
  laserFired: boolean;
}

export class GameSim {
  readonly chart: Chart;
  private analysis: TrackAnalysis;
  private shots: ChartEvent[];
  private lasers: Extract<ChartEvent, { kind: 'laser' }>[];
  private shotCursor = 0;
  private laserCursor = 0;
  private lastPos = -1;

  width = 100;
  height = 100;
  bullets: Bullet[] = [];
  activeLasers: Laser[] = [];
  player = { x: 50, y: 85, invuln: 0 };
  stats: RunStats = newStats();
  /** Audio position of the last step. */
  position = 0;

  constructor(chart: Chart, analysis: TrackAnalysis) {
    this.chart = chart;
    this.analysis = analysis;
    this.shots = chart.events.filter((e) => e.kind !== 'laser');
    this.lasers = chart.events.filter((e): e is Extract<ChartEvent, { kind: 'laser' }> => e.kind === 'laser');
  }

  get multiplier() {
    return Math.min(MAX_MULT, 1 + Math.floor(this.stats.combo / COMBO_STEP));
  }

  resize(w: number, h: number) {
    const k = 100 / Math.max(1, Math.min(w, h));
    const nw = w * k, nh = h * k;
    // Keep the player at the same relative spot
    this.player.x = (this.player.x / this.width) * nw;
    this.player.y = (this.player.y / this.height) * nh;
    this.width = nw;
    this.height = nh;
  }

  /** Back to the start of a fresh run. */
  reset() {
    this.bullets = [];
    this.activeLasers = [];
    this.player = { x: this.width / 2, y: this.height * 0.85, invuln: 0 };
    this.stats = newStats();
    this.lastPos = -1;
    this.position = 0;
    this.shotCursor = 0;
    this.laserCursor = 0;
  }

  /** World position of emitter `index` of the section playing at `t`, blended across section changes. */
  emitterAt(index: number, t: number): [number, number] {
    const { sections } = this.chart;
    const si = sectionIndexAt(sections, t);
    const sec = sections[si];
    let [x, y] = emitterPosition(sec.emitters[index % sec.emitters.length], t);
    const k = (t - sec.start) / SECTION_BLEND;
    if (si > 0 && k < 1) {
      const prev = sections[si - 1];
      const [px, py] = emitterPosition(prev.emitters[index % prev.emitters.length], t);
      const e = k * k * (3 - 2 * k);
      x = px + (x - px) * e;
      y = py + (y - py) * e;
    }
    return [x * this.width, y * this.height];
  }

  /** Emitters of the section at `t` (count). */
  emitterCount(t: number) {
    return this.chart.sections[sectionIndexAt(this.chart.sections, t)].emitters.length;
  }

  /** Shots scheduled within (position, position + window], for telegraphs. */
  *upcoming(window: number) {
    for (let i = this.shotCursor; i < this.shots.length && this.shots[i].t <= this.position + window; i++) {
      if (this.shots[i].t > this.position) yield this.shots[i];
    }
  }

  levelAt(t: number) {
    const a = this.analysis;
    return a.level[Math.min(a.level.length - 1, Math.max(0, Math.round(t * a.fps)))] ?? 0;
  }

  private resync(pos: number) {
    const find = (arr: { t: number }[], v: number) => {
      let a = 0, b = arr.length;
      while (a < b) { const m = (a + b) >> 1; if (arr[m].t <= v) a = m + 1; else b = m; }
      return a;
    };
    this.bullets = [];
    this.activeLasers = [];
    this.shotCursor = find(this.shots, pos);
    // Lasers whose warning already started are skipped: they'd fire without a fair warning
    let li = find(this.lasers, pos);
    while (li < this.lasers.length && this.lasers[li].t - this.lasers[li].warn <= pos) li++;
    this.laserCursor = li;
  }

  private movePlayer(dt: number, input: GameInput) {
    const p = this.player;
    if (input.dx || input.dy) {
      const len = Math.hypot(input.dx, input.dy);
      const v = (input.focus ? FOCUS_SPEED : PLAYER_SPEED) / Math.max(1, len);
      p.x += input.dx * v * dt;
      p.y += input.dy * v * dt;
    } else if (input.target) {
      const [tx, ty] = input.target;
      const dx = tx - p.x, dy = ty - p.y;
      const dist = Math.hypot(dx, dy);
      const max = (input.focus ? POINTER_FOCUS_SPEED : POINTER_SPEED) * dt;
      if (dist <= max) { p.x = tx; p.y = ty; } else { p.x += (dx / dist) * max; p.y += (dy / dist) * max; }
    }
    p.x = Math.min(this.width - 1, Math.max(1, p.x));
    p.y = Math.min(this.height - 1, Math.max(1, p.y));
  }

  private aimAt(x: number, y: number) {
    return Math.atan2(this.player.y - y, this.player.x - x);
  }

  private spawn(e: ChartEvent, pos: number, res: StepResult) {
    const [ex, ey] = this.emitterAt(e.emitter, e.t);
    // Never fire point blank at the player
    if (Math.hypot(ex - this.player.x, ey - this.player.y) < SAFE_SPAWN_RADIUS) return;
    const room = MAX_BULLETS - this.bullets.length;
    if (room <= 0) return;
    const base = { x: ex, y: ey, grazed: false, born: e.t, minSpeed: 0, decel: 0, curve: 0 };
    const add = (b: Bullet) => {
      if (this.bullets.length >= MAX_BULLETS) return;
      this.advance(b, pos - e.t);
      this.bullets.push(b);
    };
    switch (e.kind) {
      case 'ring':
        for (let i = 0; i < e.count; i++) {
          const angle = e.phase + (i * 2 * Math.PI) / e.count;
          add({ ...base, angle, speed: e.speed + (e.decel ? 14 : 0), minSpeed: e.speed * 0.55, decel: e.decel, curve: e.curve, r: e.size, aimed: false });
        }
        res.fired.push({ x: ex, y: ey, size: e.count / 20 });
        break;
      case 'fan': {
        const aim = this.aimAt(ex, ey);
        for (let i = 0; i < e.count; i++) {
          const off = e.count > 1 ? (i / (e.count - 1) - 0.5) * 2 * e.spread : 0;
          add({ ...base, angle: aim + off, speed: e.speed, r: e.size, aimed: true });
        }
        res.fired.push({ x: ex, y: ey, size: 0.5 });
        break;
      }
      case 'pellet':
        add({ ...base, angle: this.aimAt(ex, ey), speed: e.speed, r: 0.55, aimed: true });
        res.fired.push({ x: ex, y: ey, size: 0.2 });
        break;
      case 'stream':
        add({ ...base, angle: e.angle, speed: e.speed, r: 0.65, aimed: false });
        break;
    }
  }

  private advance(b: Bullet, dt: number) {
    if (dt <= 0) return;
    if (b.decel) b.speed = Math.max(b.minSpeed, b.speed - b.decel * dt);
    if (b.curve) b.angle += b.curve * dt;
    b.x += Math.cos(b.angle) * b.speed * dt;
    b.y += Math.sin(b.angle) * b.speed * dt;
  }

  private takeHit(res: StepResult) {
    const p = this.player;
    res.hit = true;
    this.stats.hits++;
    this.stats.combo = 0;
    p.invuln = INVULN;
    // Clear the area so one mistake doesn't chain into several
    this.bullets = this.bullets.filter((b) => {
      const near = Math.hypot(b.x - p.x, b.y - p.y) < HIT_CLEAR_RADIUS;
      if (near) res.popped.push({ x: b.x, y: b.y });
      return !near;
    });
  }

  step(pos: number, dt: number, input: GameInput): StepResult {
    const res: StepResult = { hit: false, grazes: 0, fired: [], popped: [], laserFired: false };
    const jumped = this.lastPos >= 0 && (pos < this.lastPos || pos - this.lastPos > MAX_CATCHUP);
    if (this.lastPos < 0 || jumped) {
      // Jumping back to the very start is a clean restart; any other seek (or starting
      // mid-song) makes it a practice run
      if (jumped && pos < 0.1) this.reset();
      else if (jumped || pos > 0.5) this.stats.practice = true;
      this.resync(pos);
      this.lastPos = pos;
      this.position = pos;
      return res;
    }
    const adv = pos - this.lastPos;
    this.lastPos = pos;
    this.position = pos;
    const p = this.player;

    this.movePlayer(Math.min(dt, 0.1), input);
    p.invuln = Math.max(0, p.invuln - adv);

    for (const b of this.bullets) this.advance(b, adv);
    const m = 8;
    this.bullets = this.bullets.filter((b) => b.x > -m && b.x < this.width + m && b.y > -m && b.y < this.height + m);

    while (this.shotCursor < this.shots.length && this.shots[this.shotCursor].t <= pos) {
      this.spawn(this.shots[this.shotCursor++], pos, res);
    }

    // Lasers lock their aim when the warning starts
    while (this.laserCursor < this.lasers.length && this.lasers[this.laserCursor].t - this.lasers[this.laserCursor].warn <= pos) {
      const e = this.lasers[this.laserCursor++];
      const [x, y] = this.emitterAt(e.emitter, e.t - e.warn);
      this.activeLasers.push({ x, y, angle: this.aimAt(x, y), fire: e.t, warn: e.warn, duration: e.duration });
    }
    this.activeLasers = this.activeLasers.filter((l) => pos < l.fire + l.duration);

    // ---- Collisions ----
    if (p.invuln <= 0) {
      for (const l of this.activeLasers) {
        if (pos < l.fire) continue;
        if (pos - adv < l.fire) res.laserFired = true;
        const dx = p.x - l.x, dy = p.y - l.y;
        const along = dx * Math.cos(l.angle) + dy * Math.sin(l.angle);
        const across = Math.abs(-dx * Math.sin(l.angle) + dy * Math.cos(l.angle));
        if (along > 0 && across < LASER_WIDTH / 2 + PLAYER_RADIUS) { this.takeHit(res); break; }
      }
    } else {
      for (const l of this.activeLasers) if (pos >= l.fire && pos - adv < l.fire) res.laserFired = true;
    }
    if (p.invuln <= 0 && !res.hit) {
      for (const b of this.bullets) {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < b.r + PLAYER_RADIUS) { this.takeHit(res); break; }
        if (!b.grazed && d < b.r + GRAZE_RADIUS) { b.grazed = true; res.grazes++; }
      }
    }

    // ---- Score ----
    const s = this.stats;
    if (!res.hit) s.combo += adv;
    const mult = this.multiplier;
    s.maxMult = Math.max(s.maxMult, mult);
    s.grazes += res.grazes;
    s.score += adv * 10 * mult * (0.5 + this.levelAt(pos)) + res.grazes * 20 * mult;
    return res;
  }
}
