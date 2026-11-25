/** One line of a song's lyrics; empty text is a gap without singing. */
export interface LyricLine {
  /** Seconds. */
  start: number;
  /** When it's gone again: the next line's start, or earlier if that's far off. */
  end: number;
  text: string;
}

/** A line stays at most this long, plus some per character, when nothing follows it for a while. */
const HOLD = 4;
const HOLD_PER_CHAR = 0.08;

/** Tags timed lyrics are found in, best first; they only count if there are timestamps in them. */
const LYRIC_TAGS = ['SYNCEDLYRICS', 'LYRICS', 'UNSYNCEDLYRICS', 'USLT'];

function toLines(entries: { start: number; text: string }[]): LyricLine[] | null {
  const sorted = entries
    .map((e) => ({ start: Math.max(0, e.start), text: e.text.trim() }))
    .sort((a, b) => a.start - b.start);
  const lines: LyricLine[] = [];
  for (const e of sorted) {
    const prev = lines.at(-1);
    // Same moment twice: a translation under its line
    if (prev && e.start - prev.start < 0.01) prev.text = `${prev.text} ${e.text}`.trim();
    else lines.push({ ...e, end: Infinity });
  }
  lines.forEach((l, i) => {
    l.end = Math.min(lines[i + 1]?.start ?? Infinity, l.start + HOLD + HOLD_PER_CHAR * l.text.length);
  });
  return lines.some((l) => l.text) ? lines : null;
}

/** LRC text; null if nothing in it is timed. */
export function parseLrc(text: string): LyricLine[] | null {
  // Positive means the lyrics come up sooner
  const offset = Number(/\[offset:\s*([+-]?\d+)\s*\]/i.exec(text)?.[1] ?? 0) / 1000;
  const entries: { start: number; text: string }[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stamps = /^\s*(?:\[\d+:\d+(?:[.:]\d+)?\]\s*)+/.exec(line)?.[0];
    if (!stamps) continue;
    // Word times aren't used
    const words = line.slice(stamps.length).replace(/<\d+:\d+(?:[.:]\d+)?>/g, '');
    for (const [, m, s, frac] of stamps.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
      entries.push({ start: Number(m) * 60 + Number(`${s}.${frac ?? 0}`) - offset, text: words });
    }
  }
  return toLines(entries);
}

/** The index of the line showing at t, -1 for none. */
export function lyricIndexAt(lines: LyricLine[], t: number) {
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t < lines[lo - 1].end && lines[lo - 1].text ? lo - 1 : -1;
}

async function bytes(file: Blob, from: number, length: number) {
  return new Uint8Array(await file.slice(from, from + length).arrayBuffer());
}

const ascii = (b: Uint8Array, from: number, length: number) => String.fromCharCode(...b.subarray(from, from + length));

/** The first of the tags that holds timed lyrics. */
function fromTags(tags: Map<string, string>) {
  for (const key of LYRIC_TAGS) {
    const lines = parseLrc(tags.get(key) ?? '');
    if (lines) return lines;
  }
  return null;
}

async function readFlac(file: Blob, from: number) {
  for (let at = from + 4; ;) {
    const head = await bytes(file, at, 4);
    if (head.length < 4) return null;
    const length = (head[1] << 16) | (head[2] << 8) | head[3];
    if ((head[0] & 0x7f) === 4) return fromTags(vorbisComments(await bytes(file, at + 4, length)));
    if (head[0] & 0x80) return null;
    at += 4 + length;
  }
}

function vorbisComments(b: Uint8Array) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const utf8 = new TextDecoder();
  const tags = new Map<string, string>();
  let at = 4 + view.getUint32(0, true);
  const count = view.getUint32(at, true);
  at += 4;
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(at, true);
    const text = utf8.decode(b.subarray(at + 4, at + 4 + length));
    const eq = text.indexOf('=');
    if (eq > 0) tags.set(text.slice(0, eq).toUpperCase(), text.slice(eq + 1));
    at += 4 + length;
  }
  return tags;
}

const syncsafe = (b: Uint8Array, at: number) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];
const uint32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Takes out the zeros put in so the tag can't look like audio. */
function deunsync(b: Uint8Array) {
  return b.filter((v, i) => !(v === 0 && i > 0 && b[i - 1] === 0xff));
}

/** An ID3 string in its encoding, up to its terminator: the text and where the next thing starts. */
function id3String(b: Uint8Array, from: number, encoding: number): [string, number] {
  const wide = encoding === 1 || encoding === 2;
  const step = wide ? 2 : 1;
  let end = from;
  while (end + step <= b.length && (b[end] !== 0 || (wide && b[end + 1] !== 0))) end += step;
  let start = from;
  let label = encoding === 3 ? 'utf-8' : 'windows-1252';
  if (wide) {
    label = b[from] === 0xff && b[from + 1] === 0xfe ? 'utf-16le' : b[from] === 0xfe && b[from + 1] === 0xff ? 'utf-16be' : encoding === 2 ? 'utf-16be' : 'utf-16le';
    if ((b[from] === 0xff && b[from + 1] === 0xfe) || (b[from] === 0xfe && b[from + 1] === 0xff)) start += 2;
  }
  return [new TextDecoder(label).decode(b.subarray(start, end)), end + step];
}

/** ID3v2.3 and 2.4; the timed frame first, then LRC in the plain one or in a custom tag. */
function readId3(head: Uint8Array, body: Uint8Array) {
  const version = head[3];
  if (version !== 3 && version !== 4) return null;
  const b = version === 3 && head[5] & 0x80 ? deunsync(body) : body;
  const tags = new Map<string, string>();
  let timed: LyricLine[] | null = null;
  let at = 0;
  if (head[5] & 0x40) at = version === 4 ? syncsafe(b, 0) : 4 + uint32(b, 0);
  while (at + 10 <= b.length && b[at] !== 0) {
    const id = ascii(b, at, 4);
    const size = version === 4 ? syncsafe(b, at + 4) : uint32(b, at + 4);
    const flags = b[at + 9];
    let f = b.subarray(at + 10, at + 10 + size);
    at += 10 + size;
    // Compressed or encrypted
    if (version === 4 ? flags & 0x0c : flags & 0xc0) continue;
    if (version === 4 && flags & 0x02) f = deunsync(f);
    if (version === 4 && flags & 0x01) f = f.subarray(4);
    if (id === 'TXXX') {
      const [name, next] = id3String(f, 1, f[0]);
      tags.set(name.toUpperCase(), id3String(f, next, f[0])[0]);
    } else if (id === 'USLT') {
      const [, next] = id3String(f, 4, f[0]);
      tags.set('USLT', id3String(f, next, f[0])[0]);
    } else if (id === 'SYLT' && f[4] === 2 && f[5] <= 2) {
      timed ??= readSylt(f);
    }
  }
  return timed ?? fromTags(tags);
}

/** Timed by line or by syllable; in the latter a line break opens each new line. */
function readSylt(f: Uint8Array) {
  const entries: { start: number; text: string }[] = [];
  let [, at] = id3String(f, 6, f[0]);
  while (at < f.length) {
    const [text, next] = id3String(f, at, f[0]);
    if (next + 4 > f.length) break;
    entries.push({ start: uint32(f, next) / 1000, text });
    at = next + 4;
  }
  const breaks = /^[\r\n]/;
  if (entries.slice(1).some((e) => breaks.test(e.text))) {
    const lines: typeof entries = [];
    for (const e of entries) {
      const prev = lines.at(-1);
      if (prev && !breaks.test(e.text)) prev.text += e.text;
      else lines.push({ ...e });
    }
    return toLines(lines);
  }
  return toLines(entries);
}

/**
 * The timed lyrics in an audio file's tags (FLAC, or anything with an ID3 tag such as MP3), null
 * if there are none. Only reads the tags; lyrics that can't be read count as none.
 */
export async function readLyrics(file: Blob): Promise<LyricLine[] | null> {
  try {
    const head = await bytes(file, 0, 10);
    let at = 0;
    if (ascii(head, 0, 3) === 'ID3') {
      const size = syncsafe(head, 6);
      const lines = readId3(head, await bytes(file, 10, size));
      if (lines) return lines;
      at = 10 + size;
    }
    return ascii(await bytes(file, at, 4), 0, 4) === 'fLaC' ? await readFlac(file, at) : null;
  } catch (err) {
    console.warn('Could not read lyrics', err);
    return null;
  }
}
