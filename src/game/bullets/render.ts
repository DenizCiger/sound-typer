import type { Hit } from '../../audio/driver';
import { prepareCanvas, Shake, SHAKE_MAX_PX } from '../common';
import type { EffectSettings } from '../types';
import { GRAZE_RADIUS, PLAYER_RADIUS, type GameSim, type StepResult } from './sim';

const BG = '#0d0d10';
const NEUTRAL = '255, 255, 255';
const DANGER = '255, 107, 107';
const PLAYER = '125, 211, 252';
const TELEGRAPH = 0.35;

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

interface Wave {
  x: number;
  y: number;
  age: number;
  max: number;
  power: number;
}

const spriteCache = new Map<string, HTMLCanvasElement>();

/** Pre-rendered glowing dot, so hundreds of bullets are just drawImage calls. */
function sprite(rgb: string, radiusPx: number, glow: number) {
  const r = Math.max(1, Math.round(radiusPx * 2) / 2);
  const g = Math.round(glow * 4) / 4;
  const key = `${rgb}|${r}|${g}`;
  let c = spriteCache.get(key);
  if (c) return c;
  const halo = r * (1.6 + 1.4 * g);
  const size = Math.ceil(halo * 2 + 2) * devicePixelRatio;
  c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const m = size / devicePixelRatio / 2;
  if (g > 0) {
    const grad = ctx.createRadialGradient(m, m, r * 0.6, m, m, halo);
    grad.addColorStop(0, `rgba(${rgb}, ${0.45 * Math.min(1, g)})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, m * 2, m * 2);
  }
  ctx.beginPath();
  ctx.arc(m, m, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${rgb})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(m, m, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  spriteCache.set(key, c);
  return c;
}

export class GameRenderer {
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private shake = new Shake();
  private flash = 0;
  private pulse = 0;
  private scroll = 0;
  private time = 0;

  reset() {
    this.particles = [];
    this.waves = [];
    this.shake = new Shake();
    this.flash = 0;
    this.pulse = 0;
  }

  private burst(x: number, y: number, n: number, color: string, speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: 0.25 + Math.random() * 0.35 });
    }
  }

  /** Feeds one frame of game events and music hits into the effects. */
  update(sim: GameSim, res: StepResult, hits: Hit[], dt: number, fx: EffectSettings) {
    this.time += dt;
    const level = sim.levelAt(sim.position);
    this.scroll += dt * (4 + 26 * level * level);

    for (const h of hits) {
      if (fx.screenshake && h.strength >= fx.shakeThreshold) {
        this.shake.kick(SHAKE_MAX_PX * fx.screenshakeMultiplier * Math.pow(h.strength, 1.5) * (0.5 + 0.5 * h.lowness));
      }
      this.pulse = Math.max(this.pulse, h.strength * fx.glowIntensity);
    }
    for (const f of res.fired) {
      if (f.size >= 0.5) this.waves.push({ x: f.x, y: f.y, age: 0, max: 0.5, power: Math.min(1.5, f.size) });
    }
    if (res.laserFired && fx.screenshake) this.shake.kick(SHAKE_MAX_PX * 0.6 * fx.screenshakeMultiplier);
    if (res.hit) {
      this.flash = 1;
      if (fx.screenshake) this.shake.kick(SHAKE_MAX_PX * 1.4 * fx.screenshakeMultiplier);
      this.burst(sim.player.x, sim.player.y, 36, PLAYER, 45, 0.7);
    }
    for (const p of res.popped) this.burst(p.x, p.y, 2, NEUTRAL, 18, 0.4);
    if (res.grazes) this.burst(sim.player.x, sim.player.y, Math.min(6, res.grazes * 2), NEUTRAL, 22, 0.25);

    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-dt * 3);
      p.vy *= Math.exp(-dt * 3);
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const w of this.waves) w.age += dt;
    this.waves = this.waves.filter((w) => w.age < w.max);
    this.flash *= Math.exp(-dt / 0.25);
    this.pulse *= Math.exp(-dt / 0.18);

    this.shake.step(dt);
  }

  draw(canvas: HTMLCanvasElement, sim: GameSim, fx: EffectSettings) {
    const c = prepareCanvas(canvas);
    if (!c) return;
    const { ctx, w, h, dpr } = c;
    const u = Math.min(w, h) / 100; // px per world unit
    const pos = sim.position;
    const level = sim.levelAt(pos);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.translate(this.shake.x, this.shake.y);

    // ---- Background grid, scrolling with the loudness ----
    const cell = 10 * u;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.03 + 0.04 * level + 0.06 * Math.min(1, this.pulse)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const off = (this.scroll * u) % cell;
    for (let y = off - cell; y < h + cell; y += cell) { ctx.moveTo(-20, y); ctx.lineTo(w + 20, y); }
    for (let x = (w / 2) % cell - cell; x < w + cell; x += cell) { ctx.moveTo(x, -20); ctx.lineTo(x, h + 20); }
    ctx.stroke();

    // ---- Shockwaves from big patterns ----
    for (const wv of this.waves) {
      const k = wv.age / wv.max;
      ctx.beginPath();
      ctx.arc(wv.x * u, wv.y * u, (3 + 25 * wv.power * k) * u, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${NEUTRAL}, ${0.35 * (1 - k) * wv.power})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ---- Lasers ----
    const reach = Math.hypot(w, h) * 1.2;
    for (const l of sim.activeLasers) {
      const x0 = l.x * u, y0 = l.y * u;
      const x1 = x0 + Math.cos(l.angle) * reach, y1 = y0 + Math.sin(l.angle) * reach;
      ctx.lineCap = 'round';
      if (pos < l.fire) {
        const k = 1 - (l.fire - pos) / l.warn;
        ctx.strokeStyle = `rgba(${DANGER}, ${0.15 + 0.45 * k * (0.7 + 0.3 * Math.sin(this.time * 60))})`;
        ctx.lineWidth = 1 + k * 2;
        ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const k = 1 - (pos - l.fire) / l.duration;
        ctx.strokeStyle = `rgba(${DANGER}, ${0.35 * k})`;
        ctx.lineWidth = 3.2 * u * 2.2;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.strokeStyle = `rgba(255, 235, 235, ${0.95 * k})`;
        ctx.lineWidth = 3.2 * u * 0.6;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }

    // ---- Emitters, with a charge-up telegraph before they fire on the beat ----
    const n = sim.emitterCount(pos);
    const charge = new Float32Array(n);
    for (const e of sim.upcoming(TELEGRAPH)) {
      if (e.kind !== 'ring' && e.kind !== 'fan') continue;
      const k = 1 - (e.t - pos) / TELEGRAPH;
      const i = e.emitter % n;
      charge[i] = Math.max(charge[i], k * (e.kind === 'ring' ? 1 : 0.6));
    }
    for (let i = 0; i < n; i++) {
      const [ex, ey] = sim.emitterAt(i, pos);
      const x = ex * u, y = ey * u;
      const size = (2.2 + 0.6 * level + 0.8 * Math.min(1, this.pulse)) * u;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(this.time * 1.5 + i);
      ctx.strokeStyle = `rgba(${NEUTRAL}, ${0.55 + 0.4 * level})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = `rgba(${NEUTRAL}, 0.25)`;
      ctx.strokeRect(-size * 0.35, -size * 0.35, size * 0.7, size * 0.7);
      ctx.restore();
      if (charge[i] > 0) {
        const k = charge[i];
        ctx.beginPath();
        ctx.arc(x, y, (2 + 8 * (1 - k)) * u, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${NEUTRAL}, ${0.6 * k})`;
        ctx.lineWidth = 1 + k;
        ctx.stroke();
      }
    }

    // ---- Bullets ----
    const glow = fx.glowIntensity * (0.6 + 0.4 * Math.min(1, this.pulse));
    for (const b of sim.bullets) {
      const img = sprite(b.aimed ? DANGER : NEUTRAL, b.r * u, glow);
      const s = img.width / dpr;
      ctx.drawImage(img, b.x * u - s / 2, b.y * u - s / 2, s, s);
    }

    // ---- Particles ----
    for (const p of this.particles) {
      ctx.fillStyle = `rgba(${p.color}, ${p.life / p.max})`;
      const s = p.size * u;
      ctx.fillRect(p.x * u - s / 2, p.y * u - s / 2, s, s);
    }

    // ---- Player ----
    const pl = sim.player;
    const blink = pl.invuln > 0 && Math.floor(this.time * 14) % 2 === 0;
    const px = pl.x * u, py = pl.y * u;
    if (!blink) {
      const r = 2.4 * u;
      ctx.beginPath();
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r * 0.8, py + r * 0.75);
      ctx.lineTo(px, py + r * 0.35);
      ctx.lineTo(px - r * 0.8, py + r * 0.75);
      ctx.closePath();
      ctx.fillStyle = `rgba(${PLAYER}, 0.22)`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${PLAYER})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(px, py, (GRAZE_RADIUS + 0.5) * u, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${PLAYER}, ${fx.focus ? 0.3 : 0.08})`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, Math.max(2, PLAYER_RADIUS * u), 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    if (fx.focus) {
      ctx.strokeStyle = `rgb(${PLAYER})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ---- Damage flash ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.flash > 0.01) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, `rgba(${DANGER}, 0)`);
      g.addColorStop(1, `rgba(${DANGER}, ${0.45 * this.flash})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }
}
