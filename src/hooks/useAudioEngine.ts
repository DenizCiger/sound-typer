import { useRef, useCallback } from 'react';

export interface AudioEngine {
  load: (file: File) => Promise<void>;
  play: () => void;
  pause: () => void;
  setVolume: (v: number) => void;
  analyser: React.RefObject<AnalyserNode | null>;
  dataArray: React.RefObject<Uint8Array | null>;
  isReady: React.RefObject<boolean>;
}

export function useAudioEngine(onEnded: () => void): AudioEngine {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const pauseOffsetRef = useRef(0);
  const playStartTimeRef = useRef(0);
  const isReadyRef = useRef(false);

  const load = useCallback(async (file: File) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.1;

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    gainNodeRef.current = gainNode;
    dataArrayRef.current = dataArray;
    audioBufferRef.current = audioBuffer;
    pauseOffsetRef.current = 0;
    isReadyRef.current = true;
  }, []);

  const play = useCallback(() => {
    const ctx = audioCtxRef.current;
    const analyser = analyserRef.current;
    const gainNode = gainNodeRef.current;
    const audioBuffer = audioBufferRef.current;
    if (!ctx || !analyser || !gainNode || !audioBuffer) return;

    ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start(0, pauseOffsetRef.current);
    playStartTimeRef.current = ctx.currentTime;
    source.onended = () => {
      // Only trigger if we didn't manually stop (pause sets isReady before stop)
      if (sourceRef.current === source) {
        pauseOffsetRef.current = 0;
        onEnded();
      }
    };
    sourceRef.current = source;
  }, [onEnded]);

  const pause = useCallback(() => {
    const ctx = audioCtxRef.current;
    const source = sourceRef.current;
    const audioBuffer = audioBufferRef.current;
    if (!ctx || !source || !audioBuffer) return;

    const elapsed = ctx.currentTime - playStartTimeRef.current;
    pauseOffsetRef.current = Math.min(pauseOffsetRef.current + elapsed, audioBuffer.duration);
    sourceRef.current = null; // prevent onended from firing
    try { source.stop(); } catch (_) {}
    source.disconnect();
  }, []);

  const setVolume = useCallback((v: number) => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = v;
  }, []);

  return {
    load,
    play,
    pause,
    setVolume,
    analyser: analyserRef,
    dataArray: dataArrayRef,
    isReady: isReadyRef,
  };
}
