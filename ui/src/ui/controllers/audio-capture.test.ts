import { describe, expect, it } from "vitest";
import { combinePcmFrames, pcmFramesToWavBlob } from "./audio-capture.ts";

describe("audio-capture helpers", () => {
  it("combines PCM frames in order", () => {
    const pcm = combinePcmFrames([new Int16Array([1, 2]), new Int16Array([3, 4, 5])]);
    expect(Array.from(pcm)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns wav blob metadata for non-empty frames", () => {
    const { blob, pcm } = pcmFramesToWavBlob([new Int16Array([1, -1, 2])], 16000);
    expect(blob).not.toBeNull();
    expect(blob?.type).toBe("audio/wav");
    expect(pcm).not.toBeNull();
    expect(pcm?.length).toBe(3);
  });

  it("returns null blob when no frames are present", () => {
    const { blob, pcm } = pcmFramesToWavBlob([], 16000);
    expect(blob).toBeNull();
    expect(pcm).toBeNull();
  });
});
