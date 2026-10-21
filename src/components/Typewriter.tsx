import { useRef, useImperativeHandle, forwardRef, useEffect } from 'react';
import type { TextWidth, WhitespaceMode } from './Settings';
import type { DriverFrame } from '../audio/driver';
import { LOREM, MAX_VISIBLE_LINES } from '../constants';
import styles from '../styles/Typewriter.module.css';

export interface TypewriterHandle {
  /** Applies one frame of typing + effects. Returns the number of characters typed. */
  feed: (frame: DriverFrame, dt: number) => number;
  reset: () => void;
}

const IconClear = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

const WIDTH_MAP: Record<TextWidth, string | undefined> = {
  full: undefined,
  large: '80%',
  medium: '60%',
  small: '40%',
};

// Shake spring: a damped oscillator kicked by hits, so it snaps and wobbles out
const SHAKE_FREQ = 11; // Hz
const SHAKE_DAMPING = 0.32; // damping ratio (<1 = wobbly)
const SHAKE_MAX_PX = 12;
const GLOW_DECAY = 0.18; // seconds
const MAX_WORD_SNAP = 14;
// Only real hits complete words; a faint hi-hat nudging in a letter shouldn't
const MIN_SNAP_BURST = 5;

interface TypewriterProps {
  textSource?: string;
  screenshake?: boolean;
  screenshakeMultiplier?: number;
  shakeThreshold?: number;
  glowIntensity?: number;
  snapToWords?: boolean;
  cursorPosition?: 'bottom' | 'center';
  textWidth?: TextWidth;
  whitespaceMode?: WhitespaceMode;
}

export const Typewriter = forwardRef<TypewriterHandle, TypewriterProps>(({ textSource = LOREM, screenshake = true, screenshakeMultiplier = 1, shakeThreshold = 0.6, glowIntensity = 1, snapToWords = true, cursorPosition = 'bottom', textWidth = 'full', whitespaceMode = 'none' }, ref) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);

  const propsRef = useRef({ textSource, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, snapToWords, whitespaceMode });
  useEffect(() => {
    propsRef.current = { textSource, screenshake, screenshakeMultiplier, shakeThreshold, glowIntensity, snapToWords, whitespaceMode };
  });

  const linesRef = useRef<string[]>(['']);
  const sourceIndexRef = useRef(0);
  const shakeRef = useRef({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
  const glowRef = useRef(0);

  const appendCharacter = (ch: string) => {
    if (ch === '\n') {
      linesRef.current.push('');
    } else {
      linesRef.current[linesRef.current.length - 1] += ch;
    }

    if (linesRef.current.length > MAX_VISIBLE_LINES) {
      linesRef.current.splice(0, linesRef.current.length - MAX_VISIBLE_LINES);
    }
  };

  const shouldSkipImmediately = (ch: string) => {
    const mode = propsRef.current.whitespaceMode;
    if (mode === 'inline') return ch === ' ' || ch === '\t';
    if (mode === 'all') return ch === ' ' || ch === '\t' || ch === '\n';
    return false;
  };

  const peek = () => {
    const src = propsRef.current.textSource;
    return src[sourceIndexRef.current % src.length];
  };

  const typeOne = () => {
    appendCharacter(peek());
    sourceIndexRef.current++;
    const src = propsRef.current.textSource;
    // Bounded, so a whitespace-only source can't spin forever
    for (let guard = 0; guard < src.length && shouldSkipImmediately(peek()); guard++) {
      appendCharacter(peek());
      sourceIndexRef.current++;
    }
  };

  const applyShake = (dt: number) => {
    const s = shakeRef.current;
    const omega = 2 * Math.PI * SHAKE_FREQ;
    const k = omega * omega;
    const c = 2 * SHAKE_DAMPING * omega;
    // Sub-step so the spring is stable on long frames
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = Math.min(dt, 0.1) / steps;
    for (let i = 0; i < steps; i++) {
      s.vx += (-k * s.x - c * s.vx) * h;
      s.vy += (-k * s.y - c * s.vy) * h;
      s.x += s.vx * h;
      s.y += s.vy * h;
    }
    const textEl = textRef.current;
    if (!textEl) return;
    if (Math.abs(s.x) > 0.3 || Math.abs(s.y) > 0.3) {
      textEl.style.transform = `translate(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px)`;
    } else if (textEl.style.transform) {
      textEl.style.transform = '';
    }
  };

  const kickShake = (strength: number, lowness: number) => {
    const p = propsRef.current;
    if (!p.screenshake || strength < p.shakeThreshold) return;
    const s = shakeRef.current;
    // Bassy hits (kicks, booms) shake harder than crisp ones (hats, claps)
    const mag = SHAKE_MAX_PX * p.screenshakeMultiplier * Math.pow(strength, 1.5) * (0.5 + 0.5 * lowness);
    // Mostly reverse the previous direction so consecutive hits feel like impacts, not drift
    s.angle += Math.PI + (Math.random() - 0.5) * Math.PI * 0.9;
    const v = mag * 2 * Math.PI * SHAKE_FREQ;
    s.vx += Math.cos(s.angle) * v;
    s.vy += Math.sin(s.angle) * v;
  };

  const doReset = () => {
    linesRef.current = [''];
    sourceIndexRef.current = 0;
    shakeRef.current = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 };
    glowRef.current = 0;

    if (textRef.current) {
      textRef.current.textContent = '';
      textRef.current.style.transform = '';
      if (cursorRef.current) textRef.current.appendChild(cursorRef.current);
    }
    outerRef.current?.style.setProperty('--hit', '0');
    outerRef.current?.style.setProperty('--glow', '0');
  };

  useImperativeHandle(ref, () => ({
    feed(frame: DriverFrame, dt: number) {
      const container = containerRef.current;
      const textEl = textRef.current;
      if (!container || !textEl) return 0;
      const p = propsRef.current;

      for (const hit of frame.hits) {
        kickShake(hit.strength, hit.lowness);
        if (p.glowIntensity) glowRef.current = Math.max(glowRef.current, hit.strength);
      }
      applyShake(dt);

      glowRef.current *= Math.exp(-dt / GLOW_DECAY);
      const hit = glowRef.current > 0.01 ? glowRef.current : 0;
      // --hit drives the text colour (0..1); --glow the halo, scaled by the user's intensity
      outerRef.current?.style.setProperty('--hit', Math.min(1, hit * Math.max(1, p.glowIntensity)).toFixed(3));
      outerRef.current?.style.setProperty('--glow', (hit * p.glowIntensity).toFixed(3));

      let count = 0;
      for (let i = 0; i < frame.burstChars; i++) { typeOne(); count++; }
      if (frame.burstChars >= MIN_SNAP_BURST && p.snapToWords) {
        // Finish the word the hit landed in, so hits slam in whole words
        for (let i = 0; i < MAX_WORD_SNAP && !/\s/.test(peek()); i++) { typeOne(); count++; }
      }
      for (let i = 0; i < frame.flowChars; i++) { typeOne(); count++; }
      if (count === 0) return 0;

      textEl.textContent = linesRef.current.join('\n');
      // Re-append cursor so it stays at the end
      if (cursorRef.current) textEl.appendChild(cursorRef.current);

      container.scrollTop = container.scrollHeight;
      return count;
    },

    reset: doReset,
  }));

  return (
    <div ref={outerRef} className={`${styles.outer} ${WIDTH_MAP[textWidth] ? styles.narrow : ''}`} style={{ '--text-width': WIDTH_MAP[textWidth] } as React.CSSProperties}>
      <div
        ref={containerRef}
        className={styles.container}
      >
        <span ref={textRef} className={styles.text}>
          <span ref={cursorRef} className={styles.cursor}>|</span>
        </span>
        <div className={`${styles.spacer} ${cursorPosition === 'center' ? styles.spacerCenter : ''}`} />
      </div>
      <button className={styles.clearBtn} onClick={doReset} title="Clear output">
        <IconClear />
      </button>
    </div>
  );
});
