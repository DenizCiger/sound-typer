export function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const AUDIO_EXT = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|webm)$/i;

/** Some systems don't know a type for every audio file, so the name counts too. */
export const isAudioFile = (f: File) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);

/** "m:ss", "1m23s" or plain seconds; null for anything else. */
export function parseTime(text: string) {
  const s = text.trim();
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(s) ?? /^(\d+)\s*m\s*(\d+(?:\.\d+)?)\s*s?$/i.exec(s);
  const secs = m ? Number(m[1]) * 60 + Number(m[2]) : s === '' ? NaN : Number(s);
  return secs >= 0 ? secs : null;
}
