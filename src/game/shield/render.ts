import type { Hit } from '../../audio/driver';
import { prepareCanvas, Shake, SHAKE_MAX_PX } from '../common';
import type { EffectSettings } from '../types';
import { FAR_R, flightDist, SHIELD_R, sideAngle, spearPose, type Spear } from './chart';
import type { ShieldSim, ShieldStep } from './sim';

/**
 * Chunky pixel look: everything is flat rectangles on a grid of CELL world units, sprites only
 * ever turn by quarters, and nothing glows or eases, so effects flash hard instead.
 */
const CELL = 0.75;
const BG = '#000';
const INK = '255, 255, 255';
const HEAVY = '255, 48, 72';
const REVERSE = '255, 190, 30';
const LANCE = '40, 220, 190';
/** Sparks per second off a lance being held. */
const HOLD_SPARKS = 40;
const BLAST_TIME = 0.16;

interface Run { x: number; y: number; w: number }
interface Sprite { len: number; runs: Run[] }

/** A sprite from rows of text, tip at x = 0 pointing at the centre, the middle row on the axis. */
function sprite(rows: string[]): Sprite {
  const runs: Run[] = [];
  const mid = (rows.length - 1) / 2;
  rows.forEach((row, r) => {
    for (const m of row.matchAll(/#+/g)) runs.push({ x: m.index, y: r - mid, w: m[0].length });
  });
  return { len: rows[0].length, runs };
}

const SPEAR_SPRITE = sprite([
  '..#.......',
  '.##.......',
  '##########',
  '.##.......',
  '..#.......',
]);

const HEAVY_SPRITE = sprite([
  '.......###..........##',
  '.....#####..........##',
  '...#######..........##',
  '.#########.....#######',
  '######################',
  '######################',
  '######################',
  '.#########.....#######',
  '...#######..........##',
  '.....#####..........##',
  '.......###..........##',
]);

const colorOf = (s: Spear) => (s.kind === 'lance' ? LANCE : s.kind === 'reverse' ? REVERSE : s.heavy ? HEAVY : INK);

/** The quarter turn taking +x onto an angle. */
const quarterOf = (angle: number) => ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4;
const COS = [1, 0, -1, 0];
const SIN = [0, 1, 0, -1];

interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }

export class ShieldRenderer {
  private particles: Particle[] = [];
  private shake = new Shake();
  private blockFlash = 0;
  private blockColor = INK;
  private hurtFlash = 0;
  private screenFlash = 0;
  private thump = 0;
  private flash = 0;
  private holding = false;
  private holdSparks = 0;
  /** Lane lit up by a heavy spear landing. */
  private blast: { side: number; left: number } | null = null;

  reset() {
    this.particles = [];
    this.shake = new Shake();
    this.blockFlash = 0;
    this.hurtFlash = 0;
    this.screenFlash = 0;
    this.thump = 0;
    this.flash = 0;
    this.holding = false;
    this.holdSparks = 0;
    this.blast = null;
  }

  /** Sparks flying off the shield on a side. */
  private sparks(side: number, n: number, color: string, speed: number, size = 1) {
    const angle = sideAngle(side);
    const x = Math.cos(angle) * SHIELD_R, y = Math.sin(angle) * SHIELD_R;
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.15 + Math.random() * 0.2, color, size });
    }
  }

  update(sim: ShieldSim, res: ShieldStep, hits: Hit[], dt: number, fx: EffectSettings) {
    for (const h of hits) {
      if (fx.screenshake && h.strength >= fx.shakeThreshold) {
        this.shake.kick(SHAKE_MAX_PX * 0.4 * fx.screenshakeMultiplier * Math.pow(h.strength, 1.5) * (0.5 + 0.5 * h.lowness));
      }
      if (h.lowness > 0.5) this.thump = Math.max(this.thump, h.strength);
      this.flash = Math.max(this.flash, h.strength);
      // Hits under a held note rattle the shield
      if (this.holding) this.sparks(sim.side, 3 + Math.round(6 * h.strength), LANCE, 45);
    }
    for (const s of res.blocks) {
      const color = colorOf(s);
      this.blockFlash = 1;
      this.blockColor = color;
      if (s.heavy) {
        this.sparks(s.side, 34, HEAVY, 110, 2);
        this.blast = { side: s.side, left: BLAST_TIME };
        this.screenFlash = 1;
        if (fx.screenshake) this.shake.kick(SHAKE_MAX_PX * 1.6 * fx.screenshakeMultiplier);
      } else {
        this.sparks(s.side, 8, color, 45);
      }
    }
    if (res.hit !== null) {
      this.hurtFlash = 1;
      this.sparks(res.hit, 24, HEAVY, 70);
      if (fx.screenshake) this.shake.kick(SHAKE_MAX_PX * 1.3 * fx.screenshakeMultiplier);
    }
    this.holding = res.holding;
    if (this.holding) {
      this.holdSparks += dt * HOLD_SPARKS;
      const n = Math.floor(this.holdSparks);
      this.holdSparks -= n;
      if (n > 0) this.sparks(sim.side, n, LANCE, 35);
    }

    const decay = (v: number, tau: number) => v * Math.exp(-dt / tau);
    this.flash = decay(this.flash, 0.12);
    this.blockFlash = decay(this.blockFlash, 0.07);
    this.hurtFlash = decay(this.hurtFlash, 0.2);
    this.screenFlash = decay(this.screenFlash, 0.05);
    this.thump = decay(this.thump, 0.1);
    if (this.blast) {
      this.blast.left -= dt;
      if (this.blast.left <= 0) this.blast = null;
    }
    this.shake.step(dt);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  draw(canvas: HTMLCanvasElement, sim: ShieldSim) {
    const prep = prepareCanvas(canvas);
    if (!prep) return;
    const { ctx, w, h, dpr } = prep;
    const fill = (color: string, alpha: number, x: number, y: number, rw: number, rh: number) => {
      ctx.fillStyle = `rgba(${color}, ${alpha})`;
      ctx.fillRect(x, y, rw, rh);
    };
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    if (this.hurtFlash > 0.05) fill(HEAVY, 0.3 * this.hurtFlash, 0, 0, w, h);
    if (this.screenFlash > 0.05) fill(INK, 0.22 * this.screenFlash, 0, 0, w, h);

    // A whole number of device pixels per cell keeps every edge crisp
    const perUnit = (Math.min(w, h) / 100) * dpr;
    const cell = Math.max(1, Math.round(CELL * perUnit));
    const cells = perUnit / cell;
    const ox = Math.round(canvas.width / 2 + this.shake.x * dpr);
    const oy = Math.round(canvas.height / 2 + this.shake.y * dpr);
    /**
     * Draws from then on in cells, from (x, y) cells off the centre, with +x turned to quarter q.
     * Turns around the middle of the centre cell, so a lane on the axis stays on it on all sides.
     */
    const place = (q: number, x = 0, y = 0) => {
      const c = COS[q], n = SIN[q];
      const tx = x + (1 - c + n) / 2, ty = y + (1 - n - c) / 2;
      ctx.setTransform(c * cell, n * cell, -n * cell, c * cell, ox + tx * cell, oy + ty * cell);
    };
    const near = Math.round(SHIELD_R * cells), far = Math.round(FAR_R * cells);
    const t = sim.position;
    const spears = sim.chart.spears;

    // Spawn times are sorted, so what's in view is a run from the first unresolved spear
    let last = sim.cursor;
    while (last < spears.length && spears[last].spawn <= t) last++;

    const heavyLane = [false, false, false, false];
    for (let i = sim.cursor; i < last; i++) if (spears[i].heavy) heavyLane[spears[i].side] = true;
    for (let side = 0; side < 4; side++) {
      place(quarterOf(sideAngle(side)));
      const lane = heavyLane[side] ? HEAVY : INK;
      const alpha = heavyLane[side] ? 0.75 : side === sim.side ? 0.3 : 0.14;
      for (let d = near + 2; d < far; d += 4) fill(lane, alpha, d, 0, 2, 1);
      fill(INK, 0.3 + 0.5 * this.flash, far, -3, 2, 7);
    }
    if (this.blast) {
      place(quarterOf(sideAngle(this.blast.side)));
      fill(HEAVY, this.blast.left / BLAST_TIME, near, -4, far - near, 9);
    }

    for (let i = sim.cursor; i < last; i++) {
      const s = spears[i];
      const color = colorOf(s);
      const q = quarterOf(sideAngle(s.side));
      if (s.kind === 'lance') {
        const head = Math.max(near, Math.round(flightDist(s, t) * cells));
        const tail = Math.min(far, Math.round(flightDist(s, t, s.end) * cells));
        if (tail <= head) continue;
        place(q);
        fill(color, 0.35, head, -3, tail - head, 7);
        fill(color, 1, head, -1, tail - head, 3);
        continue;
      }
      const dist = Math.max(4, Math.round(flightDist(s, t) * cells));
      const pose = spearPose(s, t);
      place(quarterOf(pose.angle), Math.round(Math.cos(pose.angle) * dist), Math.round(Math.sin(pose.angle) * dist));
      const art = s.heavy ? HEAVY_SPRITE : SPEAR_SPRITE;
      ctx.fillStyle = `rgb(${color})`;
      // Tail first: mirrored along its length, its tail still leading the way in
      for (const r of art.runs) ctx.fillRect(pose.backwards ? art.len - r.x - r.w : r.x, r.y, r.w, 1);
    }

    // The core: a diamond that kicks with the bass and blinks while it can't be hurt
    if (!(sim.invuln > 0 && Math.floor(t * 14) % 2 === 0)) {
      place(0);
      const r = 5 + Math.round(this.thump * 2);
      ctx.fillStyle = `rgb(${this.hurtFlash > 0.1 ? HEAVY : INK})`;
      for (let y = -r; y <= r; y++) ctx.fillRect(Math.abs(y) - r, y, 2 * (r - Math.abs(y)) + 1, 1);
    }

    // The shield: holding a lance keeps it in the lance's colour
    const color = this.hurtFlash > 0.2 ? HEAVY : this.holding ? LANCE : this.blockFlash > 0.15 ? this.blockColor : INK;
    const thick = this.holding || this.blockFlash > 0.15 ? 3 : 2;
    place(quarterOf(sideAngle(sim.side)));
    ctx.fillStyle = `rgb(${color})`;
    ctx.fillRect(near - thick, -9, thick, 19);
    for (const y of [-12, 8]) ctx.fillRect(near - thick - 1, y, thick, 5);
    for (const y of [-15, 13]) ctx.fillRect(near - thick - 3, y, thick, 3);

    place(0);
    for (const p of this.particles) {
      ctx.fillStyle = `rgb(${p.color})`;
      ctx.fillRect(Math.round(p.x * cells), Math.round(p.y * cells), p.size, p.size);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
