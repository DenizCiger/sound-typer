import { useRef, useCallback, useState, useEffect } from 'react';
import type { Difficulty } from '../game/common';
import type { GameStyle } from '../game/types';
import styles from '../styles/Settings.module.css';

export type TextWidth = 'full' | 'large' | 'medium' | 'small';
export type WhitespaceMode = 'none' | 'inline' | 'all';
export type AppMode = 'type' | 'play';

export interface SettingsState {
  screenshake: boolean;
  screenshakeMultiplier: number;
  /** 0 disables the glow. */
  glowIntensity: number;
  snapToWords: boolean;
  cursorPosition: 'bottom' | 'center';
  textWidth: TextWidth;
  whitespaceMode: WhitespaceMode;
  /** Typewriter or the rhythm game. */
  mode: AppMode;
  difficulty: Difficulty;
  gameStyle: GameStyle;
}

/** How the music maps to typing. Stored separately from layout settings. */
export interface FeelPrefs {
  maxCps: number;
  dynamics: number;
  punch: number;
  shakeThreshold: number;
}

const WIDTH_STOPS: { value: TextWidth; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'large', label: 'Large' },
  { value: 'medium', label: 'Medium' },
  { value: 'small', label: 'Small' },
];

const DIFFICULTY_OPTIONS: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];

const STYLE_OPTIONS: { value: GameStyle; label: string }[] = [
  { value: 'bullets', label: 'Bullet hell' },
  { value: 'shapes', label: 'Shapes' },
  { value: 'wave', label: 'Wave' },
];

const WHITESPACE_OPTIONS: { value: WhitespaceMode; label: string }[] = [
  { value: 'none', label: 'Count all' },
  { value: 'inline', label: 'Skip inline' },
  { value: 'all', label: 'Skip all' },
];

interface Props {
  settings: SettingsState;
  feel: FeelPrefs;
  onChange: (s: SettingsState) => void;
  onFeelChange: (f: FeelPrefs) => void;
  onReset: () => void;
  onClose: () => void;
}

function snapToNearest(x: number, trackRect: DOMRect): number {
  const pct = Math.max(0, Math.min(1, (x - trackRect.left) / trackRect.width));
  const index = Math.round(pct * (WIDTH_STOPS.length - 1));
  return index;
}

interface SliderRowProps {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

function SliderRow({ label, hint, min, max, step, value, format, onChange }: SliderRowProps) {
  return (
    <div className={styles.row}>
      <div className={styles.labelGroup}>
        <span className={styles.label}>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </div>
      <div className={styles.sliderGroup}>
        <input
          type="range"
          className={styles.slider}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        <span className={styles.sliderValue}>{format(value)}</span>
      </div>
    </div>
  );
}

const formatPercent = (v: number) => `${Math.round(v * 100)}%`;
const formatMultiplier = (v: number) => `${v}x`;

export function Settings({ settings, feel, onChange, onFeelChange, onReset, onClose }: Props) {
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
    snapToNearest(clientX, rect);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.title}>Settings</div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close settings">×</button>
        </div>

        <div className={styles.section}>Typing</div>
        <SliderRow
          label="Speed"
          hint="Characters per second at full volume"
          min={5}
          max={150}
          step={5}
          value={feel.maxCps}
          format={(v) => `${v}`}
          onChange={(v) => onFeelChange({ ...feel, maxCps: v })}
        />
        <SliderRow
          label="Dynamics"
          hint="Higher = quiet parts slower, loud parts stand out"
          min={0.5}
          max={4}
          step={0.1}
          value={feel.dynamics}
          format={(v) => v.toFixed(1)}
          onChange={(v) => onFeelChange({ ...feel, dynamics: v })}
        />
        <SliderRow
          label="Punch"
          hint="How hard drum hits slam text in"
          min={0}
          max={2}
          step={0.05}
          value={feel.punch}
          format={formatPercent}
          onChange={(v) => onFeelChange({ ...feel, punch: v })}
        />
        <div className={styles.row}>
          <div className={styles.labelGroup}>
            <span className={styles.label}>Hits complete words</span>
            <span className={styles.hint}>Strong hits finish the current word</span>
          </div>
          <button
            className={`${styles.toggle} ${settings.snapToWords ? styles.toggleOn : ''}`}
            onClick={() => onChange({ ...settings, snapToWords: !settings.snapToWords })}
            aria-pressed={settings.snapToWords}
            aria-label="Hits complete words"
          />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Whitespace</span>
          <div className={styles.segmented}>
            {WHITESPACE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`${styles.segBtn} ${settings.whitespaceMode === option.value ? styles.segBtnActive : ''}`}
                onClick={() => onChange({ ...settings, whitespaceMode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.section}>Game</div>
        <div className={styles.row}>
          <div className={styles.labelGroup}>
            <span className={styles.label}>Style</span>
            <span className={styles.hint}>Dodge bullet patterns, dash through shapes, or fly the wave</span>
          </div>
          <div className={styles.segmented}>
            {STYLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`${styles.segBtn} ${settings.gameStyle === option.value ? styles.segBtnActive : ''}`}
                onClick={() => onChange({ ...settings, gameStyle: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.labelGroup}>
            <span className={styles.label}>Difficulty</span>
            <span className={styles.hint}>Bullet density and speed</span>
          </div>
          <div className={styles.segmented}>
            {DIFFICULTY_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`${styles.segBtn} ${settings.difficulty === option.value ? styles.segBtnActive : ''}`}
                onClick={() => onChange({ ...settings, difficulty: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.section}>Effects</div>
        <div className={styles.row}>
          <span className={styles.label}>Screen shake</span>
          <button
            className={`${styles.toggle} ${settings.screenshake ? styles.toggleOn : ''}`}
            onClick={() => onChange({ ...settings, screenshake: !settings.screenshake })}
            aria-pressed={settings.screenshake}
            aria-label="Screen shake"
          />
        </div>
        {settings.screenshake && (
          <>
            <SliderRow
              label="Shake strength"
              min={0.5}
              max={3}
              step={0.25}
              value={settings.screenshakeMultiplier}
              format={formatMultiplier}
              onChange={(v) => onChange({ ...settings, screenshakeMultiplier: v })}
            />
            <SliderRow
              label="Shake threshold"
              hint="Only hits stronger than this shake"
              min={0}
              max={1}
              step={0.05}
              value={feel.shakeThreshold}
              format={formatPercent}
              onChange={(v) => onFeelChange({ ...feel, shakeThreshold: v })}
            />
          </>
        )}
        <SliderRow
          label="Glow on hits"
          min={0}
          max={3}
          step={0.25}
          value={settings.glowIntensity}
          format={(v) => (v === 0 ? 'Off' : formatMultiplier(v))}
          onChange={(v) => onChange({ ...settings, glowIntensity: v })}
        />

        <div className={styles.section}>Layout</div>
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

        <button className={styles.resetBtn} onClick={onReset}>Reset to defaults</button>
      </div>
    </div>
  );
}
