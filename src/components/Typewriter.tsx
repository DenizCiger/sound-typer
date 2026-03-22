import { useRef, useImperativeHandle, forwardRef } from 'react';
import { LOREM, SILENCE_THRESHOLD, INTENSE_THRESHOLD, MAX_VISIBLE_LINES } from '../constants';
import styles from '../styles/Typewriter.module.css';

export interface TypewriterHandle {
  feed: (intensity: number, speedMultiplier: number) => number;
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

interface TypewriterProps {
  textSource?: string;
}

export const Typewriter = forwardRef<TypewriterHandle, TypewriterProps>(({ textSource = LOREM }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  const linesRef = useRef<string[]>(['']);
  const sourceIndexRef = useRef(0);
  const charAccumRef = useRef(0);
  const wasIntenseRef = useRef(false);

  const doReset = () => {
    linesRef.current = [''];
    sourceIndexRef.current = 0;
    charAccumRef.current = 0;
    wasIntenseRef.current = false;
    if (textRef.current) textRef.current.textContent = '';
    if (containerRef.current) containerRef.current.classList.remove(styles.intense);
  };

  useImperativeHandle(ref, () => ({
    feed(intensity: number, speedMultiplier: number) {
      const container = containerRef.current;
      const textEl = textRef.current;
      if (!container || !textEl) return 0;

      if (intensity < SILENCE_THRESHOLD) {
        if (wasIntenseRef.current && linesRef.current[linesRef.current.length - 1].length > 0) {
          linesRef.current.push('');
        }
        wasIntenseRef.current = false;
        container.classList.remove(styles.intense);
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

      if (intensity > INTENSE_THRESHOLD) {
        container.classList.add(styles.intense);
        wasIntenseRef.current = true;
      } else {
        container.classList.remove(styles.intense);
        wasIntenseRef.current = false;
      }

      container.scrollTop = container.scrollHeight;
      return count;
    },

    reset: doReset,
  }));

  return (
    <div className={styles.outer}>
      <div ref={containerRef} className={styles.container}>
        <span ref={textRef} className={styles.text} />
        <span className={styles.cursor}>|</span>
      </div>
      <button className={styles.clearBtn} onClick={doReset} title="Clear output">
        <IconClear />
      </button>
    </div>
  );
});
