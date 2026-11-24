export function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const AUDIO_EXT = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|webm)$/i;

/** Some systems don't know a type for every audio file, so the name counts too. */
export const isAudioFile = (f: File) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);
