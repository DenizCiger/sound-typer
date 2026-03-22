import { useRef, useImperativeHandle, forwardRef } from 'react';
import { LOREM, SILENCE_THRESHOLD, INTENSE_THRESHOLD, MAX_VISIBLE_LINES } from '../constants';
import styles from '../styles/Typewriter.module.css';

export interface TypewriterHandle {
  feed: (intensity: number, speedMultiplier: number) => void;
  reset: () => void;
}

export const Typewriter = forwardRef<TypewriterHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  // Internal state as refs — never causes re-renders
  const linesRef = useRef<string[]>(['']);
  const loremIndexRef = useRef(0);
  const charAccumRef = useRef(0);
  const wasIntenseRef = useRef(false);

  useImperativeHandle(ref, () => ({
    feed(intensity: number, speedMultiplier: number) {
      const container = containerRef.current;
      const textEl = textRef.current;
      if (!container || !textEl) return;

      if (intensity < SILENCE_THRESHOLD) {
        if (wasIntenseRef.current && linesRef.current[linesRef.current.length - 1].length > 0) {
          linesRef.current.push('');
        }
        wasIntenseRef.current = false;
        container.classList.remove(styles.intense);
        return;
      }

      charAccumRef.current += intensity * speedMultiplier;
      const count = Math.floor(charAccumRef.current);
      charAccumRef.current -= count;
      if (count === 0) return;

      let newChars = '';
      for (let i = 0; i < count; i++) {
        const ch = LOREM[loremIndexRef.current % LOREM.length];
        loremIndexRef.current++;
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
    },

    reset() {
      linesRef.current = [''];
      loremIndexRef.current = 0;
      charAccumRef.current = 0;
      wasIntenseRef.current = false;
      if (textRef.current) textRef.current.textContent = '';
      if (containerRef.current) containerRef.current.classList.remove(styles.intense);
    },
  }));

  return (
    <div ref={containerRef} className={styles.container}>
      <span ref={textRef} className={styles.text} />
      <span className={styles.cursor}>█</span>
    </div>
  );
});
