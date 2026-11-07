import type { TrackAnalysis } from '../../audio/analysis';
import { intensityAt } from '../common';
import { newStats, type GameInput, type RunStats } from '../types';
import type { ShieldChart, Side, Spear } from './chart';

/** No further damage for this long after a hit, so one slip doesn't drain a whole stream. */
const INVULN = 0.35;
const REWIND_GRACE = 2;
const MAX_CATCHUP = 0.25;
/** A spear still counts as blocked if the shield left its side this recently. */
const EARLY = 0.05;
/** The pointer has to be this far from the centre to aim the shield. */
const AIM_DEADZONE = 2;

export interface ShieldStep {
  /** Spears blocked this frame. */
  blocks: Spear[];
  /** A spear got through and hurt. */
  hit: Side | null;
  /** A lance is being held off right now. */
  holding: boolean;
  died: boolean;
  checkpoint: boolean;
  rewound: boolean;
  /** The run jumped (seek or rewind): the camera should snap. */
  jumped: boolean;
}

export class ShieldSim {
  readonly chart: ShieldChart;
  private analysis: TrackAnalysis;
  private lastPos = -1;
  private pendingRewind: number | null = null;
  private expectRewind: number | null = null;
  /** When the shield last left each side. */
  private leftAt = [-Infinity, -Infinity, -Infinity, -Infinity];
  /** Since when the shield has been off the current lance's side. */
  private offSince: number | null = null;
  /** The current lance's first contact has been reported. */
  private touched = false;

  /** Index of the first spear that hasn't been dealt with. */
  cursor = 0;
  player = { x: 50, y: 50 };
  side: Side = 0;
  invuln = 0;
  hp: number;
  stats: RunStats = newStats();
  position = 0;

  /** Testing: nothing hurts. */
  invincible = false;

  constructor(chart: ShieldChart, analysis: TrackAnalysis) {
    this.chart = chart;
    this.analysis = analysis;
    this.hp = chart.maxHp;
  }

  resize(w: number, h: number) {
    const u = Math.min(w, h) / 100;
    if (u > 0) this.player = { x: w / u / 2, y: h / u / 2 };
  }

  reset() {
    this.hp = this.chart.maxHp;
    this.stats = newStats();
    this.lastPos = -1;
    this.position = 0;
    this.pendingRewind = null;
    this.expectRewind = null;
    this.invuln = 0;
    this.side = 0;
    this.seekTo(0);
  }

  intensityAt(t: number) {
    return intensityAt(this.analysis, t);
  }

  takeRewind() {
    const r = this.pendingRewind;
    this.pendingRewind = null;
    return r;
  }

  private seekTo(t: number) {
    const s = this.chart.spears;
    let i = 0;
    while (i < s.length && s[i].end < t) i++;
    this.cursor = i;
    this.leftAt.fill(-Infinity);
    this.offSince = null;
    this.touched = false;
  }

  private aim(input: GameInput, pos: number) {
    let side = this.side as number;
    if (input.facing !== null) {
      side = input.facing;
    } else if (input.target) {
      const dx = input.target[0] - this.player.x, dy = input.target[1] - this.player.y;
      if (Math.hypot(dx, dy) >= AIM_DEADZONE) {
        side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      }
    }
    if (side !== this.side) {
      this.leftAt[this.side] = pos;
      this.side = side as Side;
    }
  }

  private facing(s: Spear) {
    return this.side === s.side || this.leftAt[s.side] >= s.arrive - EARLY;
  }

  /** A spear got past the shield. */
  private hurt(s: Spear, res: ShieldStep) {
    if (this.invuln > 0 || this.invincible) return;
    this.invuln = INVULN;
    res.hit = s.side;
  }

  /** Deals with the lance reaching the shield; true once it's over. */
  private stepLance(s: Spear, pos: number, res: ShieldStep) {
    if (this.side === s.side) {
      this.offSince = null;
      res.holding = true;
      if (!this.touched) { this.touched = true; res.blocks.push(s); }
    } else {
      this.offSince ??= pos;
      if (pos - this.offSince >= this.chart.late) this.hurt(s, res);
    }
    if (pos < s.end) return false;
    this.offSince = null;
    this.touched = false;
    return true;
  }

  step(pos: number, input: GameInput): ShieldStep {
    const res: ShieldStep = { blocks: [], hit: null, holding: false, died: false, checkpoint: false, rewound: false, jumped: false };
    const jumped = this.lastPos >= 0 && (pos < this.lastPos || pos - this.lastPos > MAX_CATCHUP);
    if (this.lastPos < 0 || jumped) {
      if (this.expectRewind !== null && Math.abs(pos - this.expectRewind) < 0.5) {
        // Our own checkpoint rewind, not a seek
        this.expectRewind = null;
        this.invuln = REWIND_GRACE;
        res.rewound = true;
      } else if (jumped && pos < 0.1) {
        this.reset();
      } else if (jumped || pos > 0.5) {
        this.invuln = Math.max(this.invuln, 0.5);
      }
      this.seekTo(pos);
      res.jumped = true;
      this.lastPos = pos;
      this.position = pos;
      return res;
    }
    // Waiting for the rewind to happen: freeze
    if (this.expectRewind !== null) return res;

    const c = this.chart;
    this.aim(input, pos);
    // Song time: the song stands still during a respawn countdown, and so does the grace
    this.invuln = Math.max(0, this.invuln - (pos - this.lastPos));
    for (const cp of c.checkpoints) if (cp > 0 && cp > this.lastPos && cp <= pos) res.checkpoint = true;

    for (; this.cursor < c.spears.length; this.cursor++) {
      const s = c.spears[this.cursor];
      if (pos < s.arrive) break;
      if (s.kind === 'lance') {
        if (!this.stepLance(s, pos, res)) break;
      } else if (this.facing(s)) {
        res.blocks.push(s);
      } else if (pos >= s.arrive + c.late) {
        this.hurt(s, res);
      } else {
        break;
      }
    }
    this.lastPos = pos;
    this.position = pos;

    if (res.hit !== null) {
      const stats = this.stats;
      stats.hits++;
      this.hp--;
      if (this.hp <= 0) {
        res.died = true;
        stats.deaths++;
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
