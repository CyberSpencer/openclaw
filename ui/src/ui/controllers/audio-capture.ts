export function combinePcmFrames(frames: Int16Array[]): Int16Array {
  const totalSamples = frames.reduce((sum, frame) => sum + frame.length, 0);
  const pcm = new Int16Array(totalSamples);
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.length;
  }
  return pcm;
}

export function encodeWavPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * 2;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(offset, pcm[i], true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

export function pcmFramesToWavBlob(
  frames: Int16Array[],
  sampleRate: number,
): { blob: Blob | null; pcm: Int16Array | null } {
  if (frames.length === 0) {
    return { blob: null, pcm: null };
  }
  const pcm = combinePcmFrames(frames);
  const wavBytes = encodeWavPcm16(pcm, sampleRate);
  return {
    blob: new Blob([wavBytes], { type: "audio/wav" }),
    pcm,
  };
}
