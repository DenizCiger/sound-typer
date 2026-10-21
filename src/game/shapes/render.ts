import type { Hit } from '../../audio/driver';
import { prepareCanvas, Shake, SHAKE_MAX_PX } from '../common';
import type { EffectSettings } from '../types';
import { geometry, type Geo, type Hazard } from './chart';
import { PLAYER_SIZE, type ShapesSim, type ShapesStep } from './sim';

const BG = '#0b0a10';
const PINK = '255, 36, 112';
const CYAN = '64, 224, 255';
const STREAKS = 70;

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
  age: number;
}

function tracePath(ctx: CanvasRenderingContext2D, g: Geo, u: number, reach: number) {
  ctx.beginPath();
  switch (g.type) {
    case 'circle':
      ctx.arc(g.x * u, g.y * u, Math.max(0, g.r * u), 0, Math.PI * 2);
      break;
    case 'rect':
      ctx.save();
      ctx.translate(g.x * u, g.y * u);
      ctx.rotate(g.rot);
      ctx.rect(-g.hw * u, -g.hh * u, g.hw * 2 * u, g.hh * 2 * u);
      ctx.restore();
      break;
    case 'line': {
      const c = Math.cos(g.angle), s = Math.sin(g.angle);
      const nx = -s * g.hw * u, ny = c * g.hw * u;
      const x = g.x * u, y = g.y * u;
      ctx.moveTo(x - c * reach + nx, y - s * reach + ny);
      ctx.lineTo(x + c * reach + nx, y + s * reach + ny);
      ctx.lineTo(x + c * reach - nx, y + s * reach - ny);
      ctx.lineTo(x - c * reach - nx, y - s * reach - ny);
      ctx.closePath();
      break;
    }
  }
}

export class ShapesRenderer {
  private particles: Particle[] = [];
  private trail: { x: number; y: number; age: number }[] = [];
  private toasts: Toast[] = [];
  private shake = new Shake();
  private flash = 0;
  private pulse = 0;
  private time = 0;
  /** Smoothed music intensity, drives the background's speed and brightness. */
  private intensity = 0;
  /** Camera punch-in on strong hits. */
  private zoom = 0;
  /** Bass thump flash. */
  private thump = 0;
  private spin = 0;
  /** Background speed streaks, in world units. */
  private streaks = Array.from({ length: STREAKS }, () => ({ x: Math.random(), y: Math.random(), z: 0.4 + Math.random() * 0.6 }));
  private streakAngle = Math.PI * 0.6;

  reset() {
    this.particles = [];
    this.trail = [];
    this.toasts = [];
    this.shake = new Shake();
    this.flash = 0;
    this.pulse = 0;
    this.zoom = 0;
    this.thump = 0;
  }

  private burst(x: number, y: number, n: number, color: string, speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: 0.4 + Math.random() * 0.6 });
    }
  }

  update(sim: ShapesSim, res: ShapesStep, hits: Hit[], dt: number, fx: EffectSettings) {
    this.time += dt;
    const p = sim.player;
    for (const h of hits) {
      if (fx.screenshake && h.strength >= fx.shakeThreshold) {
        this.shake.kick(SHAKE_MAX_PX * fx.screenshakeMultiplier * Math.pow(h.strength, 1.5) * (0.5 + 0.5 * h.lowness));
      }
      this.pulse = Math.max(this.pulse, h.strength);
      if (fx.screenshake && h.strength >= fx.shakeThreshold * 0.8) {
        this.zoom = Math.max(this.zoom, 0.035 * fx.screenshakeMultiplier * h.strength * h.strength);
      }
      if (h.lowness > 0.5) this.thump = Math.max(this.thump, h.strength);
      // Big hits swing the streaks around, so the background changes direction with the music
      if (h.strength > 0.85) this.streakAngle += (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.6);
    }
    // Follow the music quickly on the way up, ease off on the way down
    const target = sim.intensityAt(sim.position);
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt / (target > this.intensity ? 0.08 : 0.35)));
    this.spin += dt * (0.04 + 0.5 * this.intensity * this.intensity);
    const streakSpeed = 0.05 + 2.2 * this.intensity * this.intensity; // arena lengths per second
    for (const st of this.streaks) {
      st.x = (st.x + Math.cos(this.streakAngle) * streakSpeed * st.z * dt + 1) % 1;
      st.y = (st.y + Math.sin(this.streakAngle) * streakSpeed * st.z * dt + 1) % 1;
    }
    if (res.hit) {
      this.flash = 1;
      if (fx.screenshake) this.shake.kick(SHAKE_MAX_PX * 1.6 * fx.screenshakeMultiplier);
      this.burst(p.x, p.y, 30, CYAN, 50, 0.6);
    }
    if (res.died) this.toasts.push({ text: 'REWIND', age: 0 });
    if (res.checkpoint) this.toasts.push({ text: 'CHECKPOINT', age: 0 });
    if (res.dodges) this.burst(p.x, p.y, 10 * res.dodges, CYAN, 30, 0.35);
    if (res.rewound) this.trail = [];

    if (sim.dashing || this.trail.length) {
      if (sim.dashing) this.trail.push({ x: p.x, y: p.y, age: 0 });
      for (const t of this.trail) t.age += dt;
      this.trail = this.trail.filter((t) => t.age < 0.2);
    }
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
    this.shake.step(dt);
  }

  private drawHazard(ctx: CanvasRenderingContext2D, hz: Hazard, sim: ShapesSim, u: number, reach: number, fx: EffectSettings) {
    const pos = sim.position;
    const geos = geometry(hz, pos, sim.arena);
    if (pos < hz.hit) {
      // Warning: translucent and blinking faster as the beat approaches
      const k = Math.min(1, Math.max(0, (pos - hz.warn) / Math.max(0.01, hz.hit - hz.warn)));
      const blink = 0.6 + 0.4 * Math.sin(this.time * (10 + 30 * k));
      if (hz.kind === 'wall') {
        this.drawWallWarning(ctx, hz, sim, u, k * blink);
        return;
      }
      if (hz.kind === 'shot') {
        const g = geos[0];
        if (g.type !== 'circle') return;
        const x = Math.min(sim.width - 2, Math.max(2, g.x)) * u, y = Math.min(sim.height - 2, Math.max(2, g.y)) * u;
        ctx.beginPath();
        ctx.arc(x, y, (2 + 3 * (1 - k)) * u, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${PINK}, ${0.3 + 0.5 * k})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }
      for (const g of geos) {
        tracePath(ctx, g.type === 'line' ? { ...g, hw: Math.max(0.3, g.hw * 0.25) } : g, u, reach);
        ctx.fillStyle = `rgba(${PINK}, ${(0.06 + 0.16 * k) * blink})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${PINK}, ${(0.25 + 0.5 * k) * blink})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      return;
    }
    // Solid: white flash right on the beat, then hot pink
    const age = pos - hz.hit;
    const beat = 1 + 0.06 * this.pulse;
    ctx.fillStyle = age < 0.06 ? '#fff' : `rgb(${PINK})`;
    if (fx.glowIntensity > 0) {
      ctx.shadowColor = `rgba(${PINK}, 0.8)`;
      ctx.shadowBlur = 14 * fx.glowIntensity * (0.4 + 0.6 * this.intensity + 0.5 * this.pulse);
    }
    for (const g of geos) {
      const scaled: Geo = g.type === 'circle' ? { ...g, r: g.r * beat }
        : g.type === 'rect' && hz.kind !== 'bar' && hz.kind !== 'wall' ? { ...g, hw: g.hw * beat, hh: g.hh * beat } : g;
      tracePath(ctx, scaled, u, reach);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  /** A wall telegraphs as a strip on the edge it comes from, with its gap left open. */
  private drawWallWarning(ctx: CanvasRenderingContext2D, hz: Extract<Hazard, { kind: 'wall' }>, sim: ShapesSim, u: number, k: number) {
    const W = sim.width * u, H = sim.height * u;
    const across = hz.axis === 'v' ? sim.height : sim.width;
    const g0 = (hz.gap * across - hz.gapSize / 2) * u, g1 = (hz.gap * across + hz.gapSize / 2) * u;
    const depth = 1.5 * u;
    ctx.fillStyle = `rgba(${PINK}, ${0.2 + 0.6 * k})`;
    if (hz.axis === 'v') {
      const x = hz.from === 0 ? 0 : W - depth;
      ctx.fillRect(x, 0, depth, g0);
      ctx.fillRect(x, g1, depth, H - g1);
    } else {
      const y = hz.from === 0 ? 0 : H - depth;
      ctx.fillRect(0, y, g0, depth);
      ctx.fillRect(g1, y, W - g1, depth);
    }
  }

  draw(canvas: HTMLCanvasElement, sim: ShapesSim, fx: EffectSettings) {
    const c = prepareCanvas(canvas);
    if (!c) return;
    const { ctx, w, h, dpr } = c;
    const u = Math.min(w, h) / 100;
    const level = sim.levelAt(sim.position);
    const reach = Math.hypot(w, h) * 1.5;

    const inten = this.intensity;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    // Bass thump: the whole arena breathes pink from the middle
    if (this.thump > 0.02) {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, `rgba(${PINK}, ${0.16 * this.thump * (0.5 + inten)})`);
      g.addColorStop(1, `rgba(${PINK}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    // Punch in on strong hits, around the middle of the arena
    const z = 1 + this.zoom;
    ctx.translate(w / 2 + this.shake.x, h / 2 + this.shake.y);
    ctx.scale(z, z);
    ctx.translate(-w / 2, -h / 2);

    // Speed streaks: crawl in quiet parts, rush when the music is intense
    const streakLen = (0.004 + 0.06 * inten * inten) * Math.max(w, h);
    ctx.lineCap = 'round';
    for (const st of this.streaks) {
      const x = st.x * w, y = st.y * h;
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.03 + 0.22 * inten) * st.z})`;
      ctx.lineWidth = 1 + st.z;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - Math.cos(this.streakAngle) * streakLen * st.z, y - Math.sin(this.streakAngle) * streakLen * st.z);
      ctx.stroke();
    }

    // Concentric squares pumping with the loudness, spinning faster when it's intense
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(this.spin);
    const base = Math.min(w, h) * (0.16 + 0.05 * level + 0.04 * this.pulse);
    for (let i = 1; i <= 4; i++) {
      const s = base * i;
      ctx.strokeStyle = `rgba(${PINK}, ${(0.03 + 0.08 * inten + 0.1 * this.pulse) / i})`;
      ctx.lineWidth = 2 + 2 * this.pulse;
      ctx.strokeRect(-s, -s, s * 2, s * 2);
    }
    ctx.restore();

    // Arena border glows with the loudness
    ctx.strokeStyle = `rgba(${PINK}, ${0.08 + 0.35 * level * level + 0.3 * this.pulse})`;
    ctx.lineWidth = 2 + 6 * inten * (0.5 + this.pulse);
    ctx.strokeRect(0, 0, sim.width * u, sim.height * u);

    // Warnings under solids
    for (const hz of sim.active) if (sim.position < hz.hit) this.drawHazard(ctx, hz, sim, u, reach, fx);
    for (const hz of sim.active) if (sim.position >= hz.hit) this.drawHazard(ctx, hz, sim, u, reach, fx);

    for (const q of this.particles) {
      ctx.fillStyle = `rgba(${q.color}, ${q.life / q.max})`;
      const s = q.size * u;
      ctx.fillRect(q.x * u - s / 2, q.y * u - s / 2, s, s);
    }

    // ---- Player: a square leaning into its movement, with afterimages while dashing ----
    const p = sim.player;
    const size = PLAYER_SIZE * u;
    for (const t of this.trail) {
      ctx.fillStyle = `rgba(${CYAN}, ${0.35 * (1 - t.age / 0.2)})`;
      ctx.fillRect(t.x * u - size / 2, t.y * u - size / 2, size, size);
    }
    const blink = p.invuln > 0.06 && Math.floor(this.time * 14) % 2 === 0;
    if (!blink) {
      const speed = Math.hypot(p.vx, p.vy);
      ctx.save();
      ctx.translate(p.x * u, p.y * u);
      ctx.rotate(Math.atan2(p.vy, p.vx) * Math.min(1, speed / 60) * 0.25);
      const stretch = sim.dashing ? 1.35 : 1;
      ctx.fillStyle = `rgb(${CYAN})`;
      if (fx.glowIntensity > 0) {
        ctx.shadowColor = `rgba(${CYAN}, 0.8)`;
        ctx.shadowBlur = 10 * fx.glowIntensity;
      }
      ctx.fillRect((-size / 2) * stretch, -size / 2 / stretch, size * stretch, size / stretch);
      ctx.restore();
    }
    // Dash recharging: a ring that fills back up
    if (p.cooldown > 0 && !sim.dashing) {
      const k = 1 - p.cooldown / sim.dashRecharge;
      ctx.beginPath();
      ctx.arc(p.x * u, p.y * u, size * 1.1, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
      ctx.strokeStyle = `rgba(${CYAN}, 0.5)`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ---- Overlays ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(${PINK}, ${0.3 * this.flash})`;
      ctx.fillRect(0, 0, w, h);
    }
    for (const t of this.toasts) {
      const a = Math.min(1, t.age / 0.1) * Math.min(1, (1.4 - t.age) / 0.4);
      ctx.font = `700 ${Math.round(Math.min(w, h) * 0.06)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = t.text === 'REWIND' ? `rgba(${PINK}, ${a})` : `rgba(255, 255, 255, ${a * 0.85})`;
      ctx.fillText(t.text, w / 2, h * 0.3 - t.age * 12);
    }
  }
}
