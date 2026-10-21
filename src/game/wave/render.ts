import type { Hit } from '../../audio/driver';
import { prepareCanvas, Shake, SHAKE_MAX_PX } from '../common';
import type { EffectSettings } from '../types';
import { ARENA_H, indexAtX, lowerBound, ORB_R, sectionAt, SPEED_STAGES, type WaveChart } from './chart';
import type { WaveSim, WaveStep } from './sim';

/**
 * Flat look, in the app's zinc palette. The only color is the speed stage's, cool when slow and
 * hot when fast, on the wall edges, spikes and saws, so a speed change shows at a glance.
 */
const STAGE_COLORS = ['96, 165, 250', '45, 212, 191', '163, 230, 53', '250, 204, 21', '251, 146, 60', '244, 63, 94'];
const BG = '#09090b';
const ARENA = '#0e0e11';
const SOLID = '#1c1c21';
const INK = '250, 250, 250';
/** Where the wave sits across the screen. */
const PLAYER_AT = 0.3;
const TRAIL_MAX = 600;
/** Background grid spacing and parallax, so the scroll speed reads even in empty stretches. */
const GRID = 16;
const PARALLAX = 0.5;
/** Spike width and depth along spiked walls, world units. */
const SPIKE = 2.6;
const SPIKE_DEPTH = 2.4;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

interface Toast {
  text: string;
  color: string;
  age: number;
}

export class WaveRenderer {
  private particles: Particle[] = [];
  private trail: { x: number; y: number }[] = [];
  private toasts: Toast[] = [];
  private shake = new Shake();
  private flash = 0;
  private pulse = 0;
  private time = 0;
  private intensity = 0;
  private zoom = 0;
  private thump = 0;
  /** Stage color, eased so changes blend. */
  private color = STAGE_COLORS[2].split(',').map(Number);
  private stage = -1;
  /** Flash of the new stage's color on a speed change. */
  private stageFlash = 0;
  private arcs = new WeakMap<Float32Array, Float32Array>();

  reset() {
    this.particles = [];
    this.trail = [];
    this.toasts = [];
    this.shake = new Shake();
    this.flash = 0;
    this.pulse = 0;
    this.zoom = 0;
    this.thump = 0;
    this.stage = -1;
    this.stageFlash = 0;
  }

  private burst(x: number, y: number, n: number, color: string, speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: 0.5 + Math.random() * 0.7 });
    }
  }

  update(sim: WaveSim, res: WaveStep, hits: Hit[], dt: number, fx: EffectSettings) {
    this.time += dt;
    const p = sim.player;
    for (const h of hits) {
      if (fx.screenshake && h.strength >= fx.shakeThreshold) {
        this.shake.kick(SHAKE_MAX_PX * fx.screenshakeMultiplier * Math.pow(h.strength, 1.5) * (0.5 + 0.5 * h.lowness));
      }
      this.pulse = Math.max(this.pulse, h.strength);
      if (fx.screenshake && h.strength >= fx.shakeThreshold * 0.8) {
        this.zoom = Math.max(this.zoom, 0.03 * fx.screenshakeMultiplier * h.strength * h.strength);
      }
      if (h.lowness > 0.5) this.thump = Math.max(this.thump, h.strength);
    }
    const target = sim.intensityAt(sim.position);
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt / (target > this.intensity ? 0.08 : 0.35)));

    const sec = sectionAt(sim.chart, sim.position);
    if (sec.stage !== this.stage) {
      // Only announce changes the player flew through, not ones from seeking
      if (this.stage >= 0 && !res.jumped) {
        const faster = sec.stage > this.stage;
        this.toasts.push({ text: `${faster ? 'FASTER' : 'SLOWER'}  ${SPEED_STAGES[sec.stage]}×`, color: STAGE_COLORS[sec.stage], age: 0 });
        this.stageFlash = 1;
      }
      this.stage = sec.stage;
    }
    const want = STAGE_COLORS[sec.stage].split(',').map(Number);
    for (let i = 0; i < 3; i++) this.color[i] += (want[i] - this.color[i]) * (1 - Math.exp(-dt / 0.15));

    if (res.jumped) this.trail = [];
    if (res.hit) {
      this.flash = 1;
      if (fx.screenshake) this.shake.kick(SHAKE_MAX_PX * 1.6 * fx.screenshakeMultiplier);
      this.burst(p.x, p.y, 30, INK, 50, 0.6);
      this.trail = [];
    }
    if (res.orbs) this.burst(p.x, p.y, 10 * res.orbs, this.rgb(), 30, 0.4);
    if (res.died) this.toasts.push({ text: 'REWIND', color: INK, age: 0 });
    if (res.checkpoint) this.toasts.push({ text: 'CHECKPOINT', color: INK, age: 0 });

    this.trail.push({ x: p.x, y: p.y });
    if (this.trail.length > TRAIL_MAX) this.trail.splice(0, this.trail.length - TRAIL_MAX);

    for (const q of this.particles) {
      q.life -= dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vx *= Math.exp(-dt * 4);
      q.vy *= Math.exp(-dt * 4);
    }
    this.particles = this.particles.filter((q) => q.life > 0);
    for (const t of this.toasts) t.age += dt;
    this.toasts = this.toasts.filter((t) => t.age < 1.4);
    this.flash *= Math.exp(-dt / 0.2);
    this.pulse *= Math.exp(-dt / 0.15);
    this.zoom *= Math.exp(-dt / 0.12);
    this.thump *= Math.exp(-dt / 0.2);
    this.stageFlash *= Math.exp(-dt / 0.4);
    this.shake.step(dt);
  }

  private rgb() {
    return this.color.map((c) => Math.round(c)).join(', ');
  }

  draw(canvas: HTMLCanvasElement, sim: WaveSim) {
    const c = prepareCanvas(canvas);
    if (!c) return;
    const { ctx, w, h, dpr } = c;
    const chart = sim.chart;
    const p = sim.player;
    // Narrow screens shrink the arena so there's still enough of the level ahead in view
    const u = Math.min(h / ARENA_H, w / 130);
    const oy = (h - ARENA_H * u) / 2;
    const camX = p.x - (w * PLAYER_AT) / u;
    const left = camX - 5, right = camX + w / u + 5;
    const sx = (x: number) => (x - camX) * u;
    const sy = (y: number) => oy + y * u;
    const col = this.rgb();

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    const z = 1 + this.zoom;
    ctx.save();
    ctx.translate(w * PLAYER_AT + this.shake.x, h / 2 + this.shake.y);
    ctx.scale(z, z);
    ctx.translate(-w * PLAYER_AT, -h / 2);

    ctx.fillStyle = ARENA;
    ctx.fillRect(-w, sy(0), w * 3, ARENA_H * u);
    // Bass hits brighten the arena a touch
    if (this.thump > 0.02) {
      ctx.fillStyle = `rgba(${INK}, ${0.035 * this.thump})`;
      ctx.fillRect(-w, sy(0), w * 3, ARENA_H * u);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(-w, sy(0), w * 3, ARENA_H * u);
    ctx.clip();

    // Background grid, scrolling at half speed
    ctx.strokeStyle = `rgba(${INK}, 0.035)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const gx0 = Math.floor((camX * PARALLAX) / GRID) * GRID;
    for (let gx = gx0; (gx - camX * PARALLAX) * u < w * 2; gx += GRID) {
      const x = (gx - camX * PARALLAX) * u;
      ctx.moveTo(x, sy(0)); ctx.lineTo(x, sy(ARENA_H));
    }
    for (let gy = GRID; gy < ARENA_H; gy += GRID) { ctx.moveTo(-w, sy(gy)); ctx.lineTo(w * 2, sy(gy)); }
    ctx.stroke();

    // Beat lines on the stronger hits, lighting up as the wave crosses them
    for (let i = lowerBound(chart.beats, left); i < chart.beats.length && chart.beats[i].x < right; i++) {
      const b = chart.beats[i];
      const near = Math.max(0, 1 - Math.abs(b.x - p.x) / 10);
      ctx.fillStyle = `rgba(${INK}, ${0.025 + 0.03 * b.s + 0.12 * near * near})`;
      ctx.fillRect(sx(b.x) - 1, sy(0), 2, ARENA_H * u);
    }

    // Speed portals: a band in the new stage's color with chevrons pointing the way it goes
    for (let i = 1; i < chart.sections.length; i++) {
      const s = chart.sections[i], q = chart.sections[i - 1];
      if (s.x0 < left - 10 || s.x0 > right || (s.stage === q.stage && s.mini === q.mini)) continue;
      const x = sx(s.x0);
      const sc = STAGE_COLORS[s.stage];
      ctx.fillStyle = `rgba(${sc}, 0.18)`;
      ctx.fillRect(x - 2 * u, sy(0), 4 * u, ARENA_H * u);
      ctx.fillStyle = `rgb(${sc})`;
      ctx.fillRect(x - 0.3 * u, sy(0), 0.6 * u, ARENA_H * u);
      const n = Math.abs(s.stage - q.stage) || 1;
      const d = (s.stage >= q.stage ? 1 : -1) * 1.6 * u;
      ctx.strokeStyle = `rgb(${sc})`;
      ctx.lineWidth = Math.max(2, 0.6 * u);
      ctx.lineJoin = 'miter';
      for (let k = 0; k < 4; k++) {
        const y = sy(12.5 + k * 25);
        for (let j = 0; j < n; j++) {
          const cx = x + 4 * u + j * 2.2 * u;
          ctx.beginPath();
          ctx.moveTo(cx - d / 2, y - 1.8 * u); ctx.lineTo(cx + d / 2, y); ctx.lineTo(cx - d / 2, y + 1.8 * u);
          ctx.stroke();
        }
      }
    }

    // ---- Walls, blocks, saws ----
    const i0 = Math.max(0, indexAtX(chart.xs, left) - 2);
    const i1 = Math.min(chart.xs.length - 1, indexAtX(chart.xs, right) + 2);
    const edge = 2 + 2 * this.pulse;
    this.drawWall(ctx, chart, chart.top, i0, i1, -1, sx, sy, col, edge);
    this.drawWall(ctx, chart, chart.bot, i0, i1, 1, sx, sy, col, edge);

    for (const b of chart.blocks) {
      if (b.x1 < left || b.x0 > right) continue;
      const y0 = Math.max(-2, b.y0), y1 = Math.min(ARENA_H + 2, b.y1);
      const x = sx(b.x0), y = sy(y0), bw = (b.x1 - b.x0) * u, bh = (y1 - y0) * u;
      ctx.fillStyle = SOLID;
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = `rgb(${col})`;
      ctx.lineWidth = edge;
      ctx.strokeRect(x, y, bw, bh);
    }

    const spin = this.time * (3 + 9 * this.intensity);
    for (let i = lowerBound(chart.saws, left - 15); i < chart.saws.length && chart.saws[i].x < right + 15; i++) {
      const s = chart.saws[i];
      const R = s.r * (1 + 0.04 * this.pulse);
      ctx.save();
      ctx.translate(sx(s.x), sy(s.y));
      ctx.rotate(spin * (i % 2 ? 1 : -1));
      ctx.beginPath();
      const teeth = 10;
      for (let k = 0; k < teeth * 2; k++) {
        const a = (k / (teeth * 2)) * Math.PI * 2;
        const rr = (k % 2 ? R * 0.88 : R * 1.12) * u;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fillStyle = `rgb(${col})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.55 * u, 0, Math.PI * 2);
      ctx.fillStyle = SOLID;
      ctx.fill();
      ctx.fillStyle = `rgb(${col})`;
      ctx.fillRect(-R * 0.45 * u, -0.5 * u, R * 0.9 * u, u);
      ctx.restore();
    }
    ctx.restore();

    // ---- Orbs on the beat turns ----
    const orbs = chart.orbs;
    ctx.strokeStyle = `rgba(${INK}, 0.8)`;
    ctx.lineWidth = 1.5;
    for (let i = lowerBound(orbs, left); i < orbs.length && orbs[i].x < right; i++) {
      if (sim.collected.has(i) || orbs[i].x < p.x - ORB_R) continue;
      const o = orbs[i];
      const s = ORB_R * u * (0.5 + 0.1 * this.pulse);
      ctx.save();
      ctx.translate(sx(o.x), sy(o.y));
      ctx.rotate(Math.PI / 4);
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    }

    for (const q of this.particles) {
      ctx.fillStyle = `rgba(${q.color}, ${q.life / q.max})`;
      const s = q.size * u;
      ctx.fillRect(sx(q.x) - s / 2, sy(q.y) - s / 2, s, s);
    }

    // ---- The wave: a zigzag trail and an arrow head ----
    const r = sim.radius;
    if (this.trail.length > 1) {
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
      ctx.beginPath();
      let started = false;
      for (const t of this.trail) {
        if (t.x < left) continue;
        if (!started) { ctx.moveTo(sx(t.x), sy(t.y)); started = true; } else ctx.lineTo(sx(t.x), sy(t.y));
      }
      ctx.strokeStyle = `rgba(${INK}, 0.9)`;
      ctx.lineWidth = r * 1.3 * u;
      ctx.stroke();
    }
    const blink = p.invuln > 0.06 && Math.floor(this.time * 14) % 2 === 0;
    if (!blink) {
      const size = (p.mini ? 2.2 : 3.2) * u;
      ctx.save();
      ctx.translate(sx(p.x), sy(p.y));
      ctx.rotate(Math.atan2(p.dir * p.vy, p.speed));
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.7, -size * 0.65);
      ctx.lineTo(-size * 0.35, 0);
      ctx.lineTo(-size * 0.7, size * 0.65);
      ctx.closePath();
      ctx.fillStyle = `rgb(${INK})`;
      ctx.fill();
      ctx.strokeStyle = BG;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // ---- Overlays ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(${INK}, ${0.18 * this.flash})`;
      ctx.fillRect(0, 0, w, h);
    }
    // Speed change: the arena's edges flash in the new color
    if (this.stageFlash > 0.01) {
      ctx.fillStyle = `rgba(${col}, ${0.6 * this.stageFlash})`;
      const t = 0.8 * u;
      ctx.fillRect(0, oy, w, t);
      ctx.fillRect(0, oy + ARENA_H * u - t, w, t);
    }
    this.drawSpeedMeter(ctx, w, oy, col);
    const size = Math.round(Math.min(w, h) * 0.055);
    this.toasts.forEach((t, k) => {
      const a = Math.min(1, t.age / 0.1) * Math.min(1, (1.4 - t.age) / 0.4);
      ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(${t.color}, ${a})`;
      // Stacked, so toasts that come together don't overlap
      ctx.fillText(t.text, w / 2, h * 0.3 + k * size * 1.3 - t.age * 12);
    });
  }

  /** Current speed stage, top right: one bar per stage, lit up to the current one. */
  private drawSpeedMeter(ctx: CanvasRenderingContext2D, w: number, oy: number, col: string) {
    if (this.stage < 0) return;
    const bw = 6, gap = 3, bh = 14;
    const x0 = w - 16 - SPEED_STAGES.length * (bw + gap);
    const y = Math.max(16, oy + 12);
    for (let i = 0; i < SPEED_STAGES.length; i++) {
      const hh = bh * (0.4 + 0.6 * (i / (SPEED_STAGES.length - 1)));
      ctx.fillStyle = i <= this.stage ? `rgb(${col})` : `rgba(${INK}, 0.12)`;
      ctx.fillRect(x0 + i * (bw + gap), y + bh - hh, bw, hh);
    }
  }

  /** Cumulative length along a wall edge, in world units, so spikes can be spaced evenly. */
  private arcLength(chart: WaveChart, edge: Float32Array) {
    let arc = this.arcs.get(edge);
    if (!arc) {
      arc = new Float32Array(edge.length);
      for (let i = 1; i < edge.length; i++) arc[i] = arc[i - 1] + Math.hypot(chart.xs[i] - chart.xs[i - 1], edge[i] - edge[i - 1]);
      this.arcs.set(edge, arc);
    }
    return arc;
  }

  /**
   * One wall: `side` -1 is the ceiling (solid above the edge), 1 the floor. Loose sections draw
   * their edge as spikes whose tips are the collision line.
   */
  private drawWall(
    ctx: CanvasRenderingContext2D, chart: WaveChart, edge: Float32Array, i0: number, i1: number, side: number,
    sx: (x: number) => number, sy: (y: number) => number, col: string, lineWidth: number,
  ) {
    const far = side < 0 ? -20 : ARENA_H + 20;
    const arc = this.arcLength(chart, edge);
    const pts: [number, number][] = [];
    // Depth into the solid at a distance along the edge: 0 at the tips, SPIKE_DEPTH in the valleys
    const depthAt = (a: number) => SPIKE_DEPTH * (1 - Math.abs(((a / SPIKE) % 1) * 2 - 1));
    for (let i = i0; i <= i1; i++) {
      if (!chart.spiky[i] || i === i1) {
        pts.push([sx(chart.xs[i]), sy(edge[i])]);
        continue;
      }
      // Teeth every SPIKE units along the edge (anchored to the level, so they don't crawl),
      // valleys pushed into the solid along the edge's normal
      const dx = chart.xs[i + 1] - chart.xs[i], dy = edge[i + 1] - edge[i];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * side, ny = (dx / len) * side;
      const at = (f: number) => {
        const d = depthAt(arc[i] + (arc[i + 1] - arc[i]) * f);
        pts.push([sx(chart.xs[i] + dx * f + nx * d), sy(edge[i] + dy * f + ny * d)]);
      };
      at(0);
      for (let k = Math.floor(arc[i] / (SPIKE / 2)) + 1; k * (SPIKE / 2) < arc[i + 1]; k++) {
        at((k * (SPIKE / 2) - arc[i]) / Math.max(1e-6, arc[i + 1] - arc[i]));
      }
    }
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], sy(far));
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], sy(far));
    ctx.closePath();
    ctx.fillStyle = SOLID;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = `rgb(${col})`;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'miter';
    ctx.stroke();
  }
}
