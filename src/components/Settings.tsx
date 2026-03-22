import { useRef, useCallback, useState, useEffect } from 'react';
import styles from '../styles/Settings.module.css';

export type TextWidth = 'full' | 'large' | 'medium' | 'small';

export interface SettingsState {
  screenshake: boolean;
  cursorPosition: 'bottom' | 'center';
  textWidth: TextWidth;
}

const WIDTH_STOPS: { value: TextWidth; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'large', label: 'Large' },
  { value: 'medium', label: 'Medium' },
  { value: 'small', label: 'Small' },
];

interface Props {
  settings: SettingsState;
  onChange: (s: SettingsState) => void;
  onClose: () => void;
}

function snapToNearest(x: number, trackRect: DOMRect): number {
  const pct = Math.max(0, Math.min(1, (x - trackRect.left) / trackRect.width));
  const index = Math.round(pct * (WIDTH_STOPS.length - 1));
  return index;
}

export function Settings({ settings, onChange, onClose }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const draggingRef = useRef(false);

  const handleDragMove = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || !draggingRef.current) return;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const index = snapToNearest(clientX, rect);
    setDragPct(pct);
    setDragIndex(index);
  }, []);

  const handleDragEnd = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track || !draggingRef.current) return;
    draggingRef.current = false;
    const rect = track.getBoundingClientRect();
    const index = snapToNearest(clientX, rect);
    setDragIndex(null);
    setDragPct(null);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    handleDragMove(e.clientX);
  }, [handleDragMove]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (draggingRef.current) handleDragMove(e.clientX);
  }, [handleDragMove]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (draggingRef.current) handleDragEnd(e.clientX);
  }, [handleDragEnd]);

  const currentIndex = dragIndex ?? WIDTH_STOPS.findIndex((s) => s.value === settings.textWidth);
  const thumbPct = dragPct ?? (currentIndex / (WIDTH_STOPS.length - 1));

  useEffect(() => {
    if (dragIndex !== null) {
      onChange({ ...settings, textWidth: WIDTH_STOPS[dragIndex].value });
    }
  }, [dragIndex, settings, onChange]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>Settings</div>

        <div className={styles.row}>
          <span className={styles.label}>Screen shake</span>
          <button
            className={`${styles.toggle} ${settings.screenshake ? styles.toggleOn : ''}`}
            onClick={() => onChange({ ...settings, screenshake: !settings.screenshake })}
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Text anchor</span>
          <div className={styles.segmented}>
            <button
              className={`${styles.segBtn} ${settings.cursorPosition === 'bottom' ? styles.segBtnActive : ''}`}
              onClick={() => onChange({ ...settings, cursorPosition: 'bottom' })}
            >
              Bottom
            </button>
            <button
              className={`${styles.segBtn} ${settings.cursorPosition === 'center' ? styles.segBtnActive : ''}`}
              onClick={() => onChange({ ...settings, cursorPosition: 'center' })}
            >
              Center
            </button>
          </div>
        </div>
        <div className={styles.rowStacked}>
          <span className={styles.label}>Text width</span>
          <div
            ref={trackRef}
            className={styles.timeline}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{ touchAction: 'none' }}
          >
            <div className={styles.timelineTrack} />
            <div
              className={styles.timelineThumb}
              style={{ left: `${thumbPct * 100}%` }}
            />
            {WIDTH_STOPS.map((stop, i) => (
              <div
                key={stop.value}
                className={`${styles.timelineStop} ${currentIndex === i ? styles.timelineStopActive : ''}`}
                style={{ left: `${(i / (WIDTH_STOPS.length - 1)) * 100}%` }}
              >
                <div className={styles.timelineDot} />
                <span className={styles.timelineLabel}>{stop.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
