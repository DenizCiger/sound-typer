import type { Difficulty } from './common';
import type { GameStyle } from './types';

/** Everything the menu's picker offers: the game styles and the typewriter. */
export type PlayStyle = GameStyle | 'type';

export const STYLE_OPTIONS: { value: PlayStyle; label: string }[] = [
  { value: 'bullets', label: 'Bullet hell' },
  { value: 'shapes', label: 'Shapes' },
  { value: 'wave', label: 'Wave' },
  { value: 'shield', label: 'Shield' },
  { value: 'type', label: 'Typewriter' },
];

export const DIFFICULTY_OPTIONS: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];
