import { lyricIndexAt, type LyricLine } from '../audio/lyrics';

/** How a style draws its lyrics. */
export interface LyricLook {
  /** CSS font family. */
  font: string;
  /** "r, g, b" */
  color: string;
  alpha: number;
  /** Middle of the text, as a share of the screen's height. */
  y?: number;
  /** Most of the screen's height the text takes. */
  height?: number;
  /** Size of the text, e.g. to pump with the music. */
  scale?: number;
}

const WEIGHT = 800;
const FADE_IN = 0.12;
const FADE_OUT = 0.2;
const MAX_ROWS = 3;
const ROW_HEIGHT = 1.1;
/** Share of the screen's width the text takes at most, and its size of the screen's shorter side. */
const WIDTH = 0.84;
const MAX_SIZE = 0.15;

interface Layout { rows: string[]; size: number }

let cached: { key: string; layout: Layout } | null = null;

/** Breaks a line into the number of rows that lets it be drawn biggest. */
function layOut(ctx: CanvasRenderingContext2D, text: string, font: string, width: number, height: number, max: number): Layout {
  const key = [text, font, width, height, max].join('|');
  if (cached?.key === key) return cached.layout;
  ctx.font = `${WEIGHT} 100px ${font}`;
  const words = text.split(/\s+/);
  const measure = (s: string) => ctx.measureText(s).width / 100;
  let best: Layout = { rows: [text], size: 0 };
  for (let n = 1; n <= Math.min(MAX_ROWS, words.length); n++) {
    const rows = balance(words, n, measure);
    const size = Math.min(max, width / Math.max(...rows.map(measure)), height / (rows.length * ROW_HEIGHT));
    // Fewer rows unless more make it noticeably bigger
    if (size > best.size * 1.05) best = { rows, size };
  }
  cached = { key, layout: best };
  return best;
}

/** At most n rows, the widest of them as narrow as possible. */
function balance(words: string[], n: number, measure: (s: string) => number) {
  const fill = (limit: number) => {
    const rows: string[] = [];
    for (const word of words) {
      const joined = rows.length ? `${rows[rows.length - 1]} ${word}` : word;
      if (rows.length && measure(joined) <= limit) rows[rows.length - 1] = joined;
      else rows.push(word);
    }
    return rows;
  };
  let lo = Math.max(...words.map(measure)), hi = measure(words.join(' '));
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (fill(mid).length <= n) hi = mid;
    else lo = mid;
  }
  return fill(hi * 1.0001);
}

/**
 * The line being sung at t, big behind the game, in screen coordinates of the current transform.
 * A pure function of song time, so seeks and rewinds need nothing.
 */
export function drawLyrics(ctx: CanvasRenderingContext2D, w: number, h: number, lines: LyricLine[] | null, t: number, look: LyricLook) {
  const i = lines ? lyricIndexAt(lines, t) : -1;
  if (!lines || i < 0) return;
  const { start, end, text } = lines[i];
  // Short lines fade faster, so they're still there for most of their time
  const fade = Math.min(1, (end - start) / (2 * (FADE_IN + FADE_OUT)));
  const alpha = look.alpha * Math.min(1, (t - start) / (FADE_IN * fade), (end - t) / (FADE_OUT * fade));
  if (alpha < 0.004) return;
  const { rows, size } = layOut(ctx, text, look.font, w * WIDTH, h * (look.height ?? 0.5), Math.min(w, h) * MAX_SIZE);
  ctx.save();
  ctx.translate(w / 2, h * (look.y ?? 0.5));
  if (look.scale) ctx.scale(look.scale, look.scale);
  ctx.font = `${WEIGHT} ${size}px ${look.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(${look.color}, ${alpha})`;
  rows.forEach((row, k) => ctx.fillText(row, 0, (k - (rows.length - 1) / 2) * size * ROW_HEIGHT));
  ctx.restore();
}
