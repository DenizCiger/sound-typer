import type { Hit } from '../../audio/driver';
import { prepareCanvas, sectionIndexAt, Shake, SHAKE_MAX_PX } from '../common';
import type { EffectSettings } from '../types';
import { SPEED_STAGES } from '../wave/chart';
import { STAGE_COLORS } from '../wave/render';
import { borderAt, flightDist, localTime, restAt, SHIELD_R, sideAngle, spearPose, type Spear, type Voice } from './chart';
import type { ShieldSim, ShieldStep } from './sim';

/**
 * Chunky pixel look: everything is flat rectangles on a grid of CELL world units, sprites only
 * ever turn by quarters, and nothing glows, so effects flash hard instead. Everything here moves
 * with the music: the border and the screen pump on kicks, flash on hits, the dust rushes with the
 * intensity, the lanes crawl one step per beat, blocks lurch the camera, and a rest stops it all.
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
/** Where the border's tips sit on the screen, share of the shorter side from the centre. */
const BORDER_SCREEN = 0.46;
const TOAST_TIME = 1.2;
const DUST = 70;
/** How hard a block lurches the camera, screen pixels, by what it played. */
const LURCH: Record<Voice, number> = { kick: 6, snare: 4, hat: 1.5 };
const LURCH_HEAVY = 12;

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

/** What you see is what you hear: a blunt kick, a snare spear, a thin hat dart. */
const SPRITES: Record<Voice, Sprite> = {
  kick: sprite([
    '..###.....',
    '.####.....',
    '##########',
    '##########',
    '##########',
    '.####.....',
    '..###.....',
  ]),
  snare: sprite([
    '..#.......',
    '.##.......',
    '##########',
    '.##.......',
    '..#.......',
  ]),
  hat: sprite([
    '.#.....',
    '#######',
    '.#.....',
  ]),
};

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
  /** Speed stage; -1 until the first step. */
  private stage = -1;
  /** The border's reach, world units; the camera follows it. */
  private border = 34;
  private view = 1;
  private color = STAGE_COLORS[0];
  /** The colour of what this part of the song does, for the screen's wash. */
  private wash = STAGE_COLORS[0];
  private stageFlash = 0;
  private toast: { text: string; color: string; age: number } | null = null;
  private intensity = 0;
  /** Each lane's flash: a spear leaving its tip, a block on it. */
  private tips = [0, 0, 0, 0];
  private lanes = [0, 0, 0, 0];
  /** Index of the next spear to be launched. */
  private launch = 0;
  /** Camera lurch from blocks, screen pixels. */
  private lurchX = 0;
  private lurchY = 0;
  private resting = false;
  /** How far the dust has rushed out, in screen-lengths. */
  private rush = 0;

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
    this.stage = -1;
    this.stageFlash = 0;
    this.toast = null;
    this.tips.fill(0);
    this.lanes.fill(0);
    this.launch = 0;
    this.lurchX = 0;
    this.lurchY = 0;
    this.resting = false;
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
    const c = sim.chart;
    const t = sim.position;
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
      this.lanes[s.side] = 1;
      if (fx.screenshake) {
        // Knocked back along the spear's way in
        const a = sideAngle(s.side);
        const push = (s.heavy ? LURCH_HEAVY : LURCH[s.voice]) * fx.screenshakeMultiplier;
        this.lurchX -= Math.cos(a) * push;
        this.lurchY -= Math.sin(a) * push;
      }
      if (s.heavy) {
        this.sparks(s.side, 34, HEAVY, 110, 2);
        this.blast = { side: s.side, left: BLAST_TIME };
        this.screenFlash = 1;
        if (fx.screenshake) this.shake.kick(SHAKE_MAX_PX * 1.6 * fx.screenshakeMultiplier);
      } else {
        this.sparks(s.side, s.voice === 'hat' ? 3 : 8, color, 45);
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

    // Spears leave the border's tips with a pop
    if (res.jumped) {
      this.launch = 0;
      while (this.launch < c.spears.length && c.spears[this.launch].spawn <= t) this.launch++;
    }
    for (; this.launch < c.spears.length && c.spears[this.launch].spawn <= t; this.launch++) this.tips[c.spears[this.launch].from] = 1;

    const resting = restAt(c.rests, t);
    // Back from a rest: everything comes on at once
    if (this.resting && !resting && !res.jumped) this.screenFlash = 1;
    this.resting = resting;

    // Speed changes: the border and the camera open up or close in, and the colour changes at once
    const { stage } = c.parts[sectionIndexAt(c.parts, t)];
    const sec = c.sections[sectionIndexAt(c.sections, t)];
    if (stage !== this.stage) {
      // Only announce changes that were played through, not ones from seeking
      if (this.stage >= 0 && !res.jumped) {
        this.toast = { text: `${stage > this.stage ? 'FASTER' : 'SLOWER'}  ${SPEED_STAGES[stage]}×`, color: STAGE_COLORS[stage], age: 0 };
        this.stageFlash = 1;
      }
      if (this.stage < 0) this.border = borderAt(c, t);
      this.stage = stage;
    }
    // A build wears its own colour, and tightens; the drop after it bursts open at once
    this.color = sec.role === 'build' ? sec.color : STAGE_COLORS[stage];
    this.wash = sec.color;
    const reach = borderAt(c, t);
    if (res.jumped) this.border = reach;
    this.border += (reach - this.border) * (1 - Math.exp(-dt / (reach > this.border ? 0.06 : 0.25)));
    this.view = 1 + ((BORDER_SCREEN * 100) / this.border - 1) * fx.cameraZoom;
    if (this.toast) {
      this.toast.age += dt;
      if (this.toast.age >= TOAST_TIME) this.toast = null;
    }

    const target = sim.intensityAt(t);
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt / (target > this.intensity ? 0.08 : 0.35)));
    if (!resting) this.rush += dt * (0.04 + 0.5 * this.intensity);

    const decay = (v: number, tau: number) => v * Math.exp(-dt / tau);
    this.stageFlash = decay(this.stageFlash, 0.15);
    this.flash = decay(this.flash, 0.12);
    this.blockFlash = decay(this.blockFlash, 0.07);
    this.hurtFlash = decay(this.hurtFlash, 0.2);
    this.screenFlash = decay(this.screenFlash, 0.05);
    this.thump = decay(this.thump, 0.1);
    this.lurchX = decay(this.lurchX, 0.05);
    this.lurchY = decay(this.lurchY, 0.05);
    for (let i = 0; i < 4; i++) {
      this.tips[i] = decay(this.tips[i], 0.08);
      this.lanes[i] = decay(this.lanes[i], 0.07);
    }
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

  /** Which of the 4 steps of a beat the music is on, for the lanes' crawl. */
  private beatStep(sim: ShieldSim) {
    const { beats } = sim.chart;
    const t = sim.position;
    let a = 0, b = beats.length;
    while (a < b) { const m = (a + b) >> 1; if (beats[m] <= t) a = m + 1; else b = m; }
    if (a === 0 || a >= beats.length) return 0;
    return Math.floor(((t - beats[a - 1]) / (beats[a] - beats[a - 1])) * 4);
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
    // The screen pumps on the kicks, harder the more intense the music
    const pump = this.thump * (0.03 + 0.14 * this.intensity);
    if (pump > 0.01) fill(this.wash, pump, 0, 0, w, h);
    if (this.hurtFlash > 0.05) fill(HEAVY, 0.3 * this.hurtFlash, 0, 0, w, h);
    if (this.screenFlash > 0.05) fill(INK, 0.22 * this.screenFlash, 0, 0, w, h);
    if (this.stageFlash > 0.05) fill(this.color, 0.3 * this.stageFlash, 0, 0, w, h);

    // A whole number of device pixels per cell keeps every edge crisp
    const perUnit = (Math.min(w, h) / 100) * dpr * this.view;
    const cell = Math.max(1, Math.round(CELL * perUnit));
    const cells = perUnit / cell;
    const ox = Math.round(canvas.width / 2 + (this.shake.x + this.lurchX) * dpr);
    const oy = Math.round(canvas.height / 2 + (this.shake.y + this.lurchY) * dpr);
    /**
     * Draws from then on in cells, from (x, y) cells off the centre, with +x turned to quarter q.
     * Turns around the middle of the centre cell, so a lane on the axis stays on it on all sides.
     */
    const place = (q: number, x = 0, y = 0) => {
      const c = COS[q], n = SIN[q];
      const tx = x + (1 - c + n) / 2, ty = y + (1 - n - c) / 2;
      ctx.setTransform(c * cell, n * cell, -n * cell, c * cell, ox + tx * cell, oy + ty * cell);
    };
    const near = Math.round(SHIELD_R * cells);
    const far = Math.round(this.border * cells) + Math.round(this.thump * 2);
    const t = sim.position;
    const local = localTime(sim.chart.rests, t);
    const spears = sim.chart.spears;

    // Dust rushing out from the middle, with the intensity; it stops dead in a rest
    place(0);
    const span = Math.max(canvas.width, canvas.height) / cell;
    ctx.fillStyle = `rgba(${INK}, ${0.08 + 0.2 * this.intensity})`;
    for (let i = 0; i < DUST; i++) {
      // Unrelated angle and distance per speck, or they line up into a spiral
      const a = i * 2.399963;
      const d = (((Math.abs(Math.sin(i * 12.9898)) * 43758.5453) % 1 + this.rush) % 1) * span * 0.75;
      if (d < near) continue;
      ctx.fillRect(Math.round(Math.cos(a) * d), Math.round(Math.sin(a) * d), 1, 1);
    }

    // Spawn times are sorted, so what's in view is a run from the first unresolved spear
    let last = sim.cursor;
    while (last < spears.length && spears[last].spawn <= t) last++;

    const heavyLane = [false, false, false, false];
    for (let i = sim.cursor; i < last; i++) if (spears[i].heavy) heavyLane[spears[i].side] = true;
    // The lanes crawl inward a step at a time: a whole dash per beat
    const crawl = this.resting ? 0 : 3 - this.beatStep(sim);
    for (let side = 0; side < 4; side++) {
      place(quarterOf(sideAngle(side)));
      const lane = heavyLane[side] ? HEAVY : INK;
      const alpha = heavyLane[side] ? 0.75 : Math.min(1, (side === sim.side ? 0.3 : 0.14) + 0.6 * this.lanes[side]);
      for (let d = near + 1 + crawl; d < far; d += 4) fill(lane, alpha, d, 0, 2, 1);
      // The tip: pops as a spear leaves it
      const pop = Math.round(this.tips[side] * 3);
      fill(this.color, Math.min(1, 0.5 + 0.5 * this.flash + this.tips[side]), far - pop, -3 - pop, 2 + 2 * pop, 7 + 2 * pop);
    }
    // The border: a diamond with its tips where the lanes come in
    place(0);
    ctx.fillStyle = `rgba(${this.color}, ${Math.min(1, 0.45 + 0.4 * this.flash + this.stageFlash)})`;
    for (let i = 0; i < far; i++) {
      ctx.fillRect(i, far - i, 1, 1);
      ctx.fillRect(i - far, -i, 1, 1);
      ctx.fillRect(far - i, -i, 1, 1);
      ctx.fillRect(-i, far - i, 1, 1);
    }
    if (this.blast) {
      place(quarterOf(sideAngle(this.blast.side)));
      fill(HEAVY, this.blast.left / BLAST_TIME, near, -4, far - near, 9);
    }
    // A rest dims the world around the frozen spears
    if (this.resting) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fill('0, 0, 0', 0.55, 0, 0, w, h);
    }

    for (let i = sim.cursor; i < last; i++) {
      const s = spears[i];
      const color = colorOf(s);
      const q = quarterOf(sideAngle(s.side));
      if (s.kind === 'lance') {
        const head = Math.max(near, Math.round(flightDist(s, local) * cells));
        const tail = Math.min(Math.round(s.far * cells), Math.round(flightDist(s, local, s.flyEnd) * cells));
        if (tail <= head) continue;
        place(q);
        fill(color, 0.35, head, -3, tail - head, 7);
        fill(color, 1, head, -1, tail - head, 3);
        continue;
      }
      const dist = Math.max(4, Math.round(flightDist(s, local) * cells));
      const pose = spearPose(s, t);
      place(quarterOf(pose.angle), Math.round(Math.cos(pose.angle) * dist), Math.round(Math.sin(pose.angle) * dist));
      const art = s.heavy ? HEAVY_SPRITE : SPRITES[s.voice];
      ctx.fillStyle = `rgb(${color})`;
      // Tail first: mirrored along its length, its tail still leading the way in
      for (const r of art.runs) ctx.fillRect(pose.backwards ? art.len - r.x - r.w : r.x, r.y, r.w, 1);
    }

    // The core: a diamond that kicks with the bass and blinks while it can't be hurt
    if (!(sim.invuln > 0 && Math.floor(t * 14) % 2 === 0)) {
      place(0);
      const r = 5 + Math.round(this.thump * 3);
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

    if (this.toast) {
      const { text, color: tint, age } = this.toast;
      // Hard blink out at the end, like everything else here
      if (age < TOAST_TIME * 0.7 || Math.floor(age * 16) % 2 === 0) {
        const size = Math.round(Math.min(w, h) * 0.05);
        ctx.font = `700 ${size}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgb(${tint})`;
        ctx.fillText(text, w / 2, h * 0.22);
      }
    }
  }
}
