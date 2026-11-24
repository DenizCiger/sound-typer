import type { Difficulty } from './common';
import type { GameStyle } from './types';

export const STYLE_OPTIONS: { value: GameStyle; label: string }[] = [
  { value: 'bullets', label: 'Bullet hell' },
  { value: 'shapes', label: 'Shapes' },
  { value: 'wave', label: 'Wave' },
  { value: 'shield', label: 'Shield' },
];

export const DIFFICULTY_OPTIONS: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];
