import { Fragment, useRef, type ReactNode } from 'react';
import { DIFFICULTY_OPTIONS, STYLE_OPTIONS, type PlayStyle } from '../game/options';
import type { Session } from './Stage';
import { IconBars, IconFullscreen, IconGear, IconMusic, IconMuted, IconTextFile, IconTrash, IconUpload, IconVolume } from './icons';
import styles from '../styles/Menu.module.css';

interface MenuProps {
  session: Session;
  title: string;
  /** Label of the main button, which starts or resumes the song. */
  primary: string;
  results: [label: string, value: number][] | null;
  actions: { label: string; onClick: () => void }[];
  hasCheckpoints: boolean;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onFullscreen: () => void;
}

const HELP: Record<PlayStyle, { keys: ReactNode; touch: string }> = {
  bullets: {
    keys: <><kbd>WASD</kbd> / <kbd>Arrows</kbd> move, <kbd>Shift</kbd> slow and precise</>,
    touch: 'Touch: drag anywhere',
  },
  shapes: {
    keys: <><kbd>WASD</kbd> / <kbd>Arrows</kbd> move, <kbd>Space</kbd> / <kbd>Shift</kbd> / <kbd>X</kbd> dash (invulnerable)</>,
    touch: 'Touch: drag to move, tap or second finger to dash',
  },
  wave: {
    keys: <>Hold <kbd>Space</kbd> / <kbd>W</kbd> / <kbd>Up</kbd> to fly up, let go to fly down</>,
    touch: 'Touch: hold anywhere',
  },
  shield: {
    keys: <><kbd>WASD</kbd> / <kbd>Arrows</kbd> turn the shield</>,
    touch: 'Touch: press on the side to block',
  },
  type: {
    keys: <><kbd>C</kbd> clear the text</>,
    touch: 'Tap the bar at the top to jump around in the song',
  },
};

/** The card shown whenever nothing is running: before the start, paused, after the song. */
export function Menu({ session, title, primary, results, actions, hasCheckpoints, onVolume, onToggleMute, onFullscreen }: MenuProps) {
  const { analysis, status, failed, trackName, style, difficulty, textName, volume, showVisualizer } = session;
  const loaded = !!analysis;
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const pick = () => fileRef.current?.click();
  const help = HELP[style];

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.title}>{title}</div>

        {loaded ? (
          <button className={styles.track} onClick={pick} title="Load another song">
            <IconMusic />
            <span>{trackName}</span>
            <IconUpload />
          </button>
        ) : (status === null || failed) && (
          <button className={styles.picker} onClick={pick}>
            <IconUpload />
            <span>Choose an audio file</span>
            <small>or drop one anywhere</small>
          </button>
        )}

        {results && (
          <div className={styles.resultRows}>
            {results.map(([label, value]) => (
              <Fragment key={label}><span>{label}</span><span>{value}</span></Fragment>
            ))}
          </div>
        )}

        <div className={styles.segmented} role="group" aria-label="Style">
          {STYLE_OPTIONS.map((o, i) => (
            <button
              key={o.value}
              className={`${styles.segBtn} ${style === o.value ? styles.segBtnActive : ''}`}
              aria-pressed={style === o.value}
              title={`${o.label} (${i + 1})`}
              onClick={() => session.onStyleChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        {style === 'type' ? (
          <div className={styles.segmented}>
            <button className={styles.segBtn} onClick={() => textRef.current?.click()} title="Load a text to type">
              <IconTextFile />
              <span>{textName ?? 'Lorem ipsum'}</span>
              <IconUpload />
            </button>
            {textName && (
              <button className={`${styles.segBtn} ${styles.segIcon}`} onClick={session.onRemoveText} title="Back to lorem ipsum" aria-label="Remove custom text">
                <IconTrash />
              </button>
            )}
          </div>
        ) : (
          <div className={styles.segmented} role="group" aria-label="Difficulty">
            {DIFFICULTY_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`${styles.segBtn} ${difficulty === o.value ? styles.segBtnActive : ''}`}
                aria-pressed={difficulty === o.value}
                onClick={() => session.onDifficultyChange(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {loaded && (
          <>
            <button className={styles.primaryBtn} onClick={session.onTogglePlay}>{primary}</button>
            {actions.length > 0 && (
              <div className={styles.secondary}>
                {actions.map((a) => <button key={a.label} onClick={a.onClick}>{a.label}</button>)}
              </div>
            )}
          </>
        )}

        <div className={styles.help}>
          <span className={styles.keys}>{help.keys}</span>
          <span className={styles.touch}>{help.touch}</span>
          <span className={styles.keys}>
            <kbd>Esc</kbd> pause, <kbd>,</kbd> <kbd>.</kbd> {hasCheckpoints ? 'previous / next checkpoint' : '10 s back / forward'}, <kbd>1</kbd>–<kbd>5</kbd> style in this menu, wheel or <kbd>-</kbd> <kbd>+</kbd> <kbd>M</kbd> volume, <kbd>F</kbd> fullscreen
          </span>
        </div>

        <div className={styles.footer}>
          <div className={styles.volume}>
            <button className={styles.iconBtn} onClick={onToggleMute} title={volume > 0 ? 'Mute (M)' : 'Unmute (M)'} aria-label={volume > 0 ? 'Mute' : 'Unmute'}>
              {volume > 0 ? <IconVolume /> : <IconMuted />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="Volume"
              onChange={(e) => onVolume(parseFloat(e.target.value))}
            />
            <span>{Math.round(volume * 100)}%</span>
          </div>
          <button className={styles.iconBtn} onClick={session.onToggleVisualizer} aria-pressed={showVisualizer} title={showVisualizer ? 'Hide visualizer' : 'Show visualizer'}>
            <IconBars />
          </button>
          <button className={styles.iconBtn} onClick={onFullscreen} title="Fullscreen (F)"><IconFullscreen /></button>
          <button className={styles.iconBtn} onClick={session.onOpenSettings} title="Settings"><IconGear /></button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) session.onLoadFile(f);
            e.target.value = '';
          }}
        />
        <input
          ref={textRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) session.onLoadText(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
