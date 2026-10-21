import type { TrackAnalysis } from './analysis';

const ANALYSIS_SAMPLE_RATE = 22050;

let worker: Worker | null = null;
let nextId = 0;

/** Downmixes + resamples with an OfflineAudioContext, then analyzes in a worker. */
export async function analyzeBuffer(buffer: AudioBuffer): Promise<TrackAnalysis> {
  const length = Math.max(1, Math.ceil(buffer.duration * ANALYSIS_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, length, ANALYSIS_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0).slice();

  worker ??= new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<{ id: number; result: TrackAnalysis }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      resolve(e.data.result);
    };
    const onError = (e: ErrorEvent) => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      reject(e.error ?? new Error(e.message));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ id, samples, sampleRate: ANALYSIS_SAMPLE_RATE }, [samples.buffer]);
  });
}
