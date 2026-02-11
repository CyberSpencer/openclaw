/**
 * Capture processor (ported from AII-Chatbot).
 *
 * Converts mic input to PCM16 frames.
 * Optimized for low latency:
 * - Small frame size (480 samples = 20ms at 24kHz)
 * - Optional resampling to target sample rate
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.frameSize = options?.processorOptions?.frameSize || 480;
    this.targetSampleRate = options?.processorOptions?.targetSampleRate || 24000;

    this.buffer = new Float32Array(this.frameSize);
    this.bufferIndex = 0;

    // For resampling if needed
    this.inputSampleRate = sampleRate; // Global from AudioWorkletGlobalScope
    this.resampleRatio = this.targetSampleRate / this.inputSampleRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }

    const inputChannel = input[0];

    // Resample if input sample rate differs from target
    let samples = inputChannel;
    if (this.inputSampleRate !== this.targetSampleRate) {
      samples = this.resample(inputChannel);
    }

    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.bufferIndex++] = samples[i];

      if (this.bufferIndex >= this.frameSize) {
        // Convert to PCM16
        const pcm16 = new Int16Array(this.frameSize);
        for (let j = 0; j < this.frameSize; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Transferable: send ArrayBuffer to avoid extra copies
        this.port.postMessage({ type: "audio", pcm16 }, [pcm16.buffer]);

        this.bufferIndex = 0;
      }
    }

    return true;
  }

  /**
   * Simple linear interpolation resampling.
   */
  resample(input) {
    const outputLength = Math.floor(input.length * this.resampleRatio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i / this.resampleRatio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
      const t = srcIndex - srcIndexFloor;

      output[i] = input[srcIndexFloor] * (1 - t) + input[srcIndexCeil] * t;
    }

    return output;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
