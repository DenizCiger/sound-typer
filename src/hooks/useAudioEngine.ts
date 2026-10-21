import { useRef, useCallback, useMemo, useEffect } from 'react';

export interface AudioEngine {
  load: (file: File) => Promise<AudioBuffer>;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  /** Position (seconds) of the audio currently coming out of the speakers. */
  getPosition: () => number;
  analyser: React.RefObject<AnalyserNode | null>;
}

export function useAudioEngine(onEnded: () => void, initialVolume: number): AudioEngine {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const volumeRef = useRef(initialVolume);
  const pauseOffsetRef = useRef(0);
  const playStartTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  });

  const load = useCallback(async (file: File) => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => {});

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.55;
    const gainNode = ctx.createGain();
    gainNode.gain.value = volumeRef.current;
    analyser.connect(gainNode);
    gainNode.connect(ctx.destination);

    const audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    gainNodeRef.current = gainNode;
    audioBufferRef.current = audioBuffer;
    pauseOffsetRef.current = 0;
    isPlayingRef.current = false;
    return audioBuffer;
  }, []);

  const contextTime = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return 0;
    // currentTime is when the *next* block gets rendered and only advances in coarse steps.
    // The output timestamp tells us what is audible right now, latency included.
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }, []);

  const startSource = useCallback((offset: number) => {
    const ctx = audioCtxRef.current;
    const analyser = analyserRef.current;
    const audioBuffer = audioBufferRef.current;
    if (!ctx || !analyser || !audioBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    const startAt = ctx.currentTime + 0.01;
    source.start(startAt, offset);
    playStartTimeRef.current = startAt;
    source.onended = () => {
      if (sourceRef.current === source) {
        sourceRef.current = null;
        pauseOffsetRef.current = 0;
        isPlayingRef.current = false;
        onEndedRef.current();
      }
    };
    sourceRef.current = source;
  }, []);

  const getPosition = useCallback(() => {
    if (!isPlayingRef.current) return pauseOffsetRef.current;
    const elapsed = Math.max(0, contextTime() - playStartTimeRef.current);
    return Math.min(pauseOffsetRef.current + elapsed, audioBufferRef.current?.duration ?? 0);
  }, [contextTime]);

  const stopSource = useCallback(() => {
    const source = sourceRef.current;
    if (!source) return;
    // Resume from what was actually heard, not from what was already buffered
    const elapsed = Math.max(0, contextTime() - playStartTimeRef.current);
    pauseOffsetRef.current = Math.min(pauseOffsetRef.current + elapsed, audioBufferRef.current?.duration ?? 0);
    sourceRef.current = null;
    try { source.stop(); } catch { /* already stopped */ }
    source.disconnect();
  }, [contextTime]);

  const play = useCallback(() => {
    if (!audioBufferRef.current || isPlayingRef.current) return;
    audioCtxRef.current?.resume();
    startSource(pauseOffsetRef.current);
    isPlayingRef.current = true;
  }, [startSource]);

  const pause = useCallback(() => {
    if (!isPlayingRef.current) return;
    stopSource();
    isPlayingRef.current = false;
  }, [stopSource]);

  const seek = useCallback((seconds: number) => {
    if (isPlayingRef.current) {
      stopSource();
      pauseOffsetRef.current = seconds;
      startSource(seconds);
    } else {
      pauseOffsetRef.current = seconds;
    }
  }, [stopSource, startSource]);

  const setVolume = useCallback((v: number) => {
    volumeRef.current = v;
    if (gainNodeRef.current) gainNodeRef.current.gain.value = v;
  }, []);

  return useMemo(() => ({
    load,
    play,
    pause,
    seek,
    setVolume,
    getPosition,
    analyser: analyserRef,
  }), [load, play, pause, seek, setVolume, getPosition]);
}
