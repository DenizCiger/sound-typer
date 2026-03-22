import { useRef, useImperativeHandle, forwardRef } from 'react';
import type { TextWidth } from './Settings';
import { LOREM, SILENCE_THRESHOLD, MAX_VISIBLE_LINES } from '../constants';
import styles from '../styles/Typewriter.module.css';

export interface TypewriterHandle {
  feed: (intensity: number, speedMultiplier: number, shakeData?: Uint8Array | null) => number;
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

interface TypewriterProps {
  textSource?: string;
  screenshake?: boolean;
  screenshakeMultiplier?: number;
  cursorPosition?: 'bottom' | 'center';
  textWidth?: TextWidth;
}

export const Typewriter = forwardRef<TypewriterHandle, TypewriterProps>(({ textSource = LOREM, screenshake = true, screenshakeMultiplier = 1, cursorPosition = 'bottom', textWidth = 'full' }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  const screenshakeRef = useRef(screenshake);
  const shakeMultRef = useRef(screenshakeMultiplier);
  const cursorPosRef = useRef(cursorPosition);
  screenshakeRef.current = screenshake;
  shakeMultRef.current = screenshakeMultiplier;
  cursorPosRef.current = cursorPosition;

  const linesRef = useRef<string[]>(['']);
  const sourceIndexRef = useRef(0);
  const charAccumRef = useRef(0);
  const wasIntenseRef = useRef(false);
  const prevBassRef = useRef(new Float32Array(20));
  const fluxAvgRef = useRef(0);
  const shakeDxRef = useRef(0);
  const shakeDyRef = useRef(0);

  const doReset = () => {
    linesRef.current = [''];
    sourceIndexRef.current = 0;
    charAccumRef.current = 0;
    wasIntenseRef.current = false;
    prevBassRef.current.fill(0);
    fluxAvgRef.current = 0;
    shakeDxRef.current = 0;
    shakeDyRef.current = 0;

    if (textRef.current) textRef.current.textContent = '';
    if (containerRef.current) containerRef.current.style.transform = '';
  };

  useImperativeHandle(ref, () => ({
    feed(intensity: number, speedMultiplier: number, shakeData?: Uint8Array | null) {
      const container = containerRef.current;
      const textEl = textRef.current;
      if (!container || !textEl) return 0;

      // Decay shake every frame
      shakeDxRef.current *= 0.82;
      shakeDyRef.current *= 0.82;

      // Onset detection from bass spectral flux
      if (screenshakeRef.current && shakeData) {
        const BASS_BINS = 20;
        let flux = 0;
        for (let i = 0; i < BASS_BINS; i++) {
          const diff = shakeData[i] - prevBassRef.current[i];
          if (diff > 0) flux += diff;
          prevBassRef.current[i] = shakeData[i];
        }

        fluxAvgRef.current = fluxAvgRef.current * 0.95 + flux * 0.05;
        const threshold = fluxAvgRef.current * 2.5 + 120;

        if (flux > threshold) {
          const raw = (flux - threshold) / 150;
          const strength = Math.log2(1 + raw) / Math.log2(2);
          const mag = strength * 14 * shakeMultRef.current;
          shakeDxRef.current = (Math.random() * 2 - 1) * mag;
          shakeDyRef.current = (Math.random() * 2 - 1) * mag;
        }
      }

      // Apply shake transform
      if (Math.abs(shakeDxRef.current) > 0.5 || Math.abs(shakeDyRef.current) > 0.5) {
        container.style.transform = `translate(${shakeDxRef.current}px, ${shakeDyRef.current}px)`;
      } else {
        container.style.transform = '';
      }

      if (intensity < SILENCE_THRESHOLD) {
        if (wasIntenseRef.current && linesRef.current[linesRef.current.length - 1].length > 0) {
          linesRef.current.push('');
        }
        wasIntenseRef.current = false;
        return 0;
      }

      charAccumRef.current += intensity * speedMultiplier;
      const count = Math.floor(charAccumRef.current);
      charAccumRef.current -= count;
      if (count === 0) return 0;

      let newChars = '';
      for (let i = 0; i < count; i++) {
        const ch = textSource[sourceIndexRef.current % textSource.length];
        sourceIndexRef.current++;
        if (ch === '\n') {
          linesRef.current.push('');
        } else {
          newChars += ch;
        }
      }
      linesRef.current[linesRef.current.length - 1] += newChars;

      if (linesRef.current.length > MAX_VISIBLE_LINES) {
        linesRef.current.splice(0, linesRef.current.length - MAX_VISIBLE_LINES);
      }

      textEl.textContent = linesRef.current.join('\n');
      wasIntenseRef.current = true;

      container.scrollTop = container.scrollHeight;
      return count;
    },

    reset: doReset,
  }));

  return (
    <div className={styles.outer} style={{ width: WIDTH_MAP[textWidth], margin: WIDTH_MAP[textWidth] ? '0 auto' : undefined }}>
      <div
        ref={containerRef}
        className={styles.container}
      >
        <span ref={textRef} className={styles.text} />
        <span className={styles.cursor}>|</span>
        <div className={`${styles.spacer} ${cursorPosition === 'center' ? styles.spacerCenter : ''}`} />
      </div>
      <button className={styles.clearBtn} onClick={doReset} title="Clear output">
        <IconClear />
      </button>
    </div>
  );
});
