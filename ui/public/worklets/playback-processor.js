/**
 * Playback processor (ported from AII-Chatbot).
 *
 * Ring buffer for smooth audio output.
 * Note: OpenClaw currently plays Spark TTS via <audio> data URLs, so this is not
 * wired in yet. Kept for future streaming audio support.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Dynamic ring buffer configuration
    this.initialBufferSize = 24000 * 60; // 60s at 24kHz
    this.maxBufferSize = 24000 * 300; // 5min at 24kHz
    this.expansionThreshold = 0.8;

    this.bufferSize = this.initialBufferSize;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.samplesBuffered = 0;

    this.expansionCount = 0;

    // Adaptive jitter buffer
    this.minJitterBufferSamples = 240; // 10ms
    this.maxJitterBufferSamples = 1440; // 60ms
    this.jitterBufferSamples = 240;
    this.jitterBufferStep = 240;

    this.isPlaying = false;

    // Completion tracking
    this.wasPlaying = false;
    this.serverAudioComplete = false;
    this.audioReceived = false;
    this.totalSamplesPlayed = 0;
    this.totalSamplesReceived = 0;

    // Underrun tracking
    this.underrunCount = 0;
    this.underrunThreshold = 2;

    // Sequence tracking (server now guarantees order)
    this.expectedSeq = 1;

    this.port.addEventListener("message", this.handleMessage.bind(this));
    this.port.start();
  }

  expandBuffer() {
    if (this.bufferSize >= this.maxBufferSize) {
      return false;
    }

    const newSize = Math.min(this.bufferSize * 2, this.maxBufferSize);
    const newBuffer = new Float32Array(newSize);

    for (let i = 0; i < this.samplesBuffered; i++) {
      const srcIndex = (this.readIndex + i) % this.bufferSize;
      newBuffer[i] = this.buffer[srcIndex];
    }

    this.buffer = newBuffer;
    this.bufferSize = newSize;
    this.readIndex = 0;
    this.writeIndex = this.samplesBuffered;
    this.expansionCount++;

    this.port.postMessage({
      type: "buffer_expanded",
      newSizeSeconds: Math.round(newSize / 24000),
      expansionCount: this.expansionCount,
    });

    return true;
  }

  dropOldestAudio(samplesToMake) {
    if (this.samplesBuffered <= samplesToMake) {
      this.readIndex = 0;
      this.writeIndex = 0;
      this.samplesBuffered = 0;
      return;
    }

    this.readIndex = (this.readIndex + samplesToMake) % this.bufferSize;
    this.samplesBuffered -= samplesToMake;

    this.port.postMessage({
      type: "audio_dropped",
      samplesDropped: samplesToMake,
      msDropped: Math.round(samplesToMake / 24),
      reason: "buffer_at_max_capacity",
    });
  }

  writeToBuffer(data) {
    const isFirstAudio = !this.wasPlaying && this.samplesBuffered === 0;
    this.totalSamplesReceived += data.length;

    const availableSpace = this.bufferSize - this.samplesBuffered;
    if (data.length > availableSpace) {
      const fillRatio = this.samplesBuffered / this.bufferSize;
      if (fillRatio >= this.expansionThreshold && this.bufferSize < this.maxBufferSize) {
        this.expandBuffer();
      }

      while (
        data.length > this.bufferSize - this.samplesBuffered &&
        this.bufferSize < this.maxBufferSize
      ) {
        if (!this.expandBuffer()) {
          break;
        }
      }

      const finalAvailableSpace = this.bufferSize - this.samplesBuffered;
      if (data.length > finalAvailableSpace) {
        this.dropOldestAudio(data.length - finalAvailableSpace);
      }
    }

    for (let i = 0; i < data.length; i++) {
      this.buffer[this.writeIndex] = data[i];
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      this.samplesBuffered++;
    }

    if (!this.isPlaying) {
      const startThreshold = isFirstAudio
        ? Math.min(120, this.jitterBufferSamples)
        : this.jitterBufferSamples;
      if (this.samplesBuffered >= startThreshold) {
        this.isPlaying = true;
        this.wasPlaying = true;
      }
    }
  }

  handleMessage(event) {
    if (event.data.type === "audio") {
      const data = event.data.data;
      const seq = event.data.seq;

      this.audioReceived = true;
      this.writeToBuffer(data);

      if (seq !== undefined) {
        if (seq !== this.expectedSeq) {
          this.port.postMessage({
            type: "seq_mismatch",
            expected: this.expectedSeq,
            received: seq,
            note: "playing_anyway",
          });
        }
        this.expectedSeq = seq + 1;
      }
    } else if (event.data.type === "clear") {
      this.bufferSize = this.initialBufferSize;
      this.buffer = new Float32Array(this.bufferSize);
      this.writeIndex = 0;
      this.readIndex = 0;
      this.samplesBuffered = 0;
      this.isPlaying = false;
      this.wasPlaying = false;
      this.serverAudioComplete = false;
      this.audioReceived = false;
      this.totalSamplesPlayed = 0;
      this.totalSamplesReceived = 0;
      this.expansionCount = 0;
      this.expectedSeq = 1;
      this.jitterBufferSamples = this.minJitterBufferSamples;
      this.underrunCount = 0;
    } else if (event.data.type === "server_audio_complete") {
      this.serverAudioComplete = true;

      if (!this.audioReceived) {
        this.port.postMessage({
          type: "playback_complete",
          reason: "zero_audio",
          totalSamplesReceived: 0,
          totalSamplesPlayed: 0,
        });
        this.wasPlaying = false;
        this.serverAudioComplete = false;
        this.audioReceived = false;
        this.totalSamplesPlayed = 0;
        this.totalSamplesReceived = 0;
        return;
      }

      this.port.postMessage({
        type: "server_audio_complete_received",
        samplesBuffered: this.samplesBuffered,
        totalSamplesReceived: this.totalSamplesReceived,
        totalSamplesPlayed: this.totalSamplesPlayed,
        isPlaying: this.isPlaying,
      });

      if (this.samplesBuffered === 0 && this.totalSamplesPlayed > 0) {
        this.port.postMessage({
          type: "playback_complete",
          totalSamplesReceived: this.totalSamplesReceived,
          totalSamplesPlayed: this.totalSamplesPlayed,
          durationPlayedMs: Math.round(this.totalSamplesPlayed / 24),
        });
        this.wasPlaying = false;
        this.serverAudioComplete = false;
        this.audioReceived = false;
        this.totalSamplesPlayed = 0;
        this.totalSamplesReceived = 0;
      }
    } else if (event.data.type === "getStats") {
      this.port.postMessage({
        type: "stats",
        samplesBuffered: this.samplesBuffered,
        bufferSize: this.bufferSize,
        bufferSizeSeconds: Math.round(this.bufferSize / 24000),
        expansionCount: this.expansionCount,
        isPlaying: this.isPlaying,
        audioReceived: this.audioReceived,
        totalSamplesReceived: this.totalSamplesReceived,
        totalSamplesPlayed: this.totalSamplesPlayed,
        durationReceivedMs: Math.round(this.totalSamplesReceived / 24),
        durationPlayedMs: Math.round(this.totalSamplesPlayed / 24),
        expectedSeq: this.expectedSeq,
        serverAudioComplete: this.serverAudioComplete,
        jitterBufferSamples: this.jitterBufferSamples,
        underrunCount: this.underrunCount,
      });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const channel = output[0];

    if (!this.isPlaying || this.samplesBuffered === 0) {
      channel.fill(0);
      return true;
    }

    let hadUnderrun = false;
    let samplesPlayedThisFrame = 0;

    for (let i = 0; i < channel.length; i++) {
      if (this.samplesBuffered > 0) {
        channel[i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.bufferSize;
        this.samplesBuffered--;
        samplesPlayedThisFrame++;
      } else {
        channel[i] = 0;
        hadUnderrun = true;
      }
    }

    this.totalSamplesPlayed += samplesPlayedThisFrame;

    if (hadUnderrun && this.isPlaying) {
      this.underrunCount++;
      if (this.underrunCount > this.underrunThreshold) {
        const newSize = Math.min(
          this.jitterBufferSamples + this.jitterBufferStep,
          this.maxJitterBufferSamples,
        );
        if (newSize > this.jitterBufferSamples) {
          this.jitterBufferSamples = newSize;
          this.port.postMessage({
            type: "buffer_adapted",
            jitterBufferMs: Math.round(this.jitterBufferSamples / 24),
            reason: "underrun",
          });
        }
        this.underrunCount = 0;
      }
    }

    if (this.samplesBuffered === 0) {
      this.isPlaying = false;
      if (this.wasPlaying && this.serverAudioComplete && this.totalSamplesPlayed > 0) {
        this.port.postMessage({
          type: "playback_complete",
          totalSamplesReceived: this.totalSamplesReceived,
          totalSamplesPlayed: this.totalSamplesPlayed,
          durationPlayedMs: Math.round(this.totalSamplesPlayed / 24),
        });
        this.wasPlaying = false;
        this.serverAudioComplete = false;
        this.audioReceived = false;
        this.totalSamplesPlayed = 0;
        this.totalSamplesReceived = 0;
      }
    }

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
