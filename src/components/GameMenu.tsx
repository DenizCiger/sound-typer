import { useRef, type ReactNode } from 'react';
import type { Difficulty } from '../game/common';
import { DIFFICULTY_OPTIONS, STYLE_OPTIONS } from '../game/options';
import type { GameStyle } from '../game/types';
import { IconBars, IconFullscreen, IconGear, IconKeyboard, IconMusic, IconMuted, IconUpload, IconVolume } from './icons';
import styles from '../styles/GameMenu.module.css';

export interface GameMenuProps {
  title: string;
  trackName: string;
  /** The song is decoded and analysed. */
  loaded: boolean;
  /** Loading: no song to pick yet, what's being done shows as the title. */
  busy: boolean;
  /** Label of the main button; what it does is `onPrimary`. */
  primary: string;
  /** Start over / from the checkpoint make sense: a run is under way. */
  underway: boolean;
  hasCheckpoints: boolean;
  results: { hits: number; deaths: number } | null;
  style: GameStyle;
  difficulty: Difficulty;
  volume: number;
  showVisualizer: boolean;
  onPrimary: () => void;
  onRestart: () => void;
  onCheckpoint: () => void;
  onStyleChange: (style: GameStyle) => void;
  onDifficultyChange: (difficulty: Difficulty) => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onLoadFile: (file: File) => void;
  onToggleVisualizer: () => void;
  onFullscreen: () => void;
  onOpenSettings: () => void;
  /** Over to the typewriter. */
  onLeave: () => void;
}

const HELP: Record<GameStyle, { keys: ReactNode; touch: string }> = {
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
};

/** The card over the game whenever it isn't running: before the start, paused, after the song. */
export function GameMenu({
  title, trackName, loaded, busy, primary, underway, hasCheckpoints, results, style, difficulty, volume, showVisualizer,
  onPrimary, onRestart, onCheckpoint, onStyleChange, onDifficultyChange, onVolume, onToggleMute, onLoadFile,
  onToggleVisualizer, onFullscreen, onOpenSettings, onLeave,
}: GameMenuProps) {
  const fileRef = useRef<HTMLInputElement>(null);
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
        ) : !busy && (
          <button className={styles.picker} onClick={pick}>
            <IconUpload />
            <span>Choose an audio file</span>
            <small>or drop one anywhere</small>
          </button>
        )}

        {results && (
          <div className={styles.resultRows}>
            <span>Hits taken</span><span>{results.hits}</span>
            {hasCheckpoints && <><span>Rewinds</span><span>{results.deaths}</span></>}
          </div>
        )}

        <div className={styles.segmented} role="group" aria-label="Game style">
          {STYLE_OPTIONS.map((o, i) => (
            <button
              key={o.value}
              className={`${styles.segBtn} ${style === o.value ? styles.segBtnActive : ''}`}
              aria-pressed={style === o.value}
              title={`${o.label} (${i + 1})`}
              onClick={() => onStyleChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className={styles.segmented} role="group" aria-label="Difficulty">
          {DIFFICULTY_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`${styles.segBtn} ${difficulty === o.value ? styles.segBtnActive : ''}`}
              aria-pressed={difficulty === o.value}
              onClick={() => onDifficultyChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>

        {loaded && (
          <>
            <button className={styles.primaryBtn} onClick={onPrimary}>{primary}</button>
            {underway && (
              <div className={styles.secondary}>
                {hasCheckpoints && <button onClick={onCheckpoint}>From checkpoint</button>}
                <button onClick={onRestart}>Restart song</button>
              </div>
            )}
          </>
        )}

        <div className={styles.help}>
          <span className={styles.keys}>{help.keys}</span>
          <span className={styles.touch}>{help.touch}</span>
          <span className={styles.keys}>
            <kbd>Esc</kbd> pause, <kbd>,</kbd> <kbd>.</kbd> {hasCheckpoints ? 'previous / next checkpoint' : '10 s back / forward'}, <kbd>1</kbd>–<kbd>4</kbd> style in this menu, wheel or <kbd>-</kbd> <kbd>+</kbd> <kbd>M</kbd> volume, <kbd>F</kbd> fullscreen
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
          <button className={styles.textBtn} onClick={onLeave} title="Switch to the typewriter">
            <IconKeyboard />
            <span>Typewriter</span>
          </button>
          <button className={styles.iconBtn} onClick={onToggleVisualizer} aria-pressed={showVisualizer} title={showVisualizer ? 'Hide visualizer' : 'Show visualizer'}>
            <IconBars />
          </button>
          <button className={styles.iconBtn} onClick={onFullscreen} title="Fullscreen (F)"><IconFullscreen /></button>
          <button className={styles.iconBtn} onClick={onOpenSettings} title="Settings"><IconGear /></button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoadFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
