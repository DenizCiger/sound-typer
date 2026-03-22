import { useRef, useCallback } from 'react';

export interface AudioEngine {
  load: (file: File) => Promise<void>;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  getPosition: () => number;
  analyser: React.RefObject<AnalyserNode | null>;
  dataArray: React.RefObject<Uint8Array | null>;
  shakeAnalyser: React.RefObject<AnalyserNode | null>;
  shakeDataArray: React.RefObject<Uint8Array | null>;
  pauseOffset: React.RefObject<number>;
  duration: React.RefObject<number>;
}

export function useAudioEngine(onEnded: () => void): AudioEngine {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const shakeAnalyserRef = useRef<AnalyserNode | null>(null);
  const shakeDataArrayRef = useRef<Uint8Array | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const pauseOffsetRef = useRef(0);
  const playStartTimeRef = useRef(0);
  const isPlayingRef = useRef(false);

  const load = useCallback(async (file: File) => {
    // Tear down existing context if any
    if (sourceRef.current) {
      sourceRef.current = null;
      try { audioCtxRef.current?.close(); } catch (_) {}
    }

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const shakeAnalyser = ctx.createAnalyser();
    shakeAnalyser.fftSize = 512;
    shakeAnalyser.smoothingTimeConstant = 0.3;
    const shakeDataArray = new Uint8Array(shakeAnalyser.frequencyBinCount);

    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.1;

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    shakeAnalyserRef.current = shakeAnalyser;
    shakeDataArrayRef.current = shakeDataArray;
    gainNodeRef.current = gainNode;
    dataArrayRef.current = dataArray;
    audioBufferRef.current = audioBuffer;
    pauseOffsetRef.current = 0;
    isPlayingRef.current = false;
  }, []);

  const startSource = useCallback((offset: number) => {
    const ctx = audioCtxRef.current;
    const analyser = analyserRef.current;
    const gainNode = gainNodeRef.current;
    const audioBuffer = audioBufferRef.current;
    if (!ctx || !analyser || !gainNode || !audioBuffer) return;

    const shakeAnalyser = shakeAnalyserRef.current;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    if (shakeAnalyser) source.connect(shakeAnalyser);
    analyser.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start(0, offset);
    playStartTimeRef.current = ctx.currentTime;
    source.onended = () => {
      if (sourceRef.current === source) {
        pauseOffsetRef.current = 0;
        isPlayingRef.current = false;
        onEnded();
      }
    };
    sourceRef.current = source;
  }, [onEnded]);

  const stopSource = useCallback(() => {
    const ctx = audioCtxRef.current;
    const source = sourceRef.current;
    const audioBuffer = audioBufferRef.current;
    if (!source) return;

    const elapsed = (ctx?.currentTime ?? 0) - playStartTimeRef.current;
    pauseOffsetRef.current = Math.min(
      pauseOffsetRef.current + elapsed,
      audioBuffer?.duration ?? 0
    );
    sourceRef.current = null;
    try { source.stop(); } catch (_) {}
    source.disconnect();
  }, []);

  const play = useCallback(() => {
    audioCtxRef.current?.resume();
    startSource(pauseOffsetRef.current);
    isPlayingRef.current = true;
  }, [startSource]);

  const pause = useCallback(() => {
    stopSource();
    isPlayingRef.current = false;
  }, [stopSource]);

  const seek = useCallback((seconds: number) => {
    pauseOffsetRef.current = seconds;
    if (isPlayingRef.current) {
      stopSource();
      startSource(seconds);
    }
  }, [stopSource, startSource]);

  const setVolume = useCallback((v: number) => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = v;
  }, []);

  const getPosition = useCallback(() => {
    if (!isPlayingRef.current) return pauseOffsetRef.current;
    const elapsed = (audioCtxRef.current?.currentTime ?? 0) - playStartTimeRef.current;
    return pauseOffsetRef.current + elapsed;
  }, []);

  const durationRef = useRef(0);
  // Keep duration in sync via a getter-like ref
  const durationProxy = new Proxy(durationRef, {
    get(target, prop) {
      if (prop === 'current') return audioBufferRef.current?.duration ?? 0;
      return (target as any)[prop];
    }
  });

  return {
    load,
    play,
    pause,
    seek,
    setVolume,
    getPosition,
    analyser: analyserRef,
    dataArray: dataArrayRef,
    shakeAnalyser: shakeAnalyserRef,
    shakeDataArray: shakeDataArrayRef,
    pauseOffset: pauseOffsetRef,
    duration: durationProxy as React.RefObject<number>,
  };
}
