/**
 * Local STT (Speech-to-Text) using whisper-cpp.
 *
 * Provides a Node.js wrapper around the whisper-cpp binary for local
 * audio transcription without cloud API calls.
 */

import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { VoiceWhisperConfig } from "../config/types.voice.js";

const execFileAsync = promisify(execFile);

const DEFAULT_WHISPER_BINARY = "whisper-cpp";
const DEFAULT_WHISPER_BINARY_ALIASES = ["whisper-cli", "whisper"];
const DEFAULT_MODEL_CANDIDATE_PATHS = [
  path.join(process.env.HOME ?? "/tmp", ".openclaw", "whisper", "models", "ggml-base.en.bin"),
  path.join(process.env.HOME ?? "/tmp", ".openclaw", "models", "ggml-base.en.bin"),
];
const DEFAULT_MODEL_PATH = DEFAULT_MODEL_CANDIDATE_PATHS[0];
const DEFAULT_LANGUAGE = "en";
const DEFAULT_THREADS = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export type LocalSttResult = {
  success: boolean;
  text?: string;
  error?: string;
  latencyMs?: number;
  model?: string;
};

export type LocalSttConfig = Required<VoiceWhisperConfig>;

function resolveModelPath(requestedPath?: string): string {
  const requested = requestedPath?.trim();
  if (requested && existsSync(requested)) {
    return requested;
  }
  for (const candidate of DEFAULT_MODEL_CANDIDATE_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return requested || DEFAULT_MODEL_PATH;
}

function resolveWhisperBinaryCandidates(primary: string): string[] {
  const unique = new Set<string>();
  const normalizedPrimary = primary.trim();
  if (normalizedPrimary) {
    unique.add(normalizedPrimary);
  }
  unique.add(DEFAULT_WHISPER_BINARY);
  for (const alias of DEFAULT_WHISPER_BINARY_ALIASES) {
    unique.add(alias);
  }
  return Array.from(unique);
}

async function isWhisperBinaryCallable(binaryPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ["--help"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });

    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0 || code === 1)); // --help may exit 1
  });
}

export function resolveWhisperConfig(config?: VoiceWhisperConfig): LocalSttConfig {
  return {
    binaryPath: config?.binaryPath?.trim() || DEFAULT_WHISPER_BINARY,
    modelPath: resolveModelPath(config?.modelPath),
    language: config?.language?.trim() || DEFAULT_LANGUAGE,
    threads: config?.threads ?? DEFAULT_THREADS,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Check if whisper-cpp is available.
 */
export async function isWhisperAvailable(config: LocalSttConfig): Promise<boolean> {
  // Check if model file exists
  if (!existsSync(config.modelPath)) {
    return false;
  }

  const candidates = resolveWhisperBinaryCandidates(config.binaryPath);
  for (const binaryPath of candidates) {
    if (await isWhisperBinaryCallable(binaryPath)) {
      return true;
    }
  }
  return false;
}

/**
 * Transcribe audio using whisper-cpp.
 *
 * Automatically converts non-WAV formats (webm, ogg) to 16kHz mono WAV
 * using ffmpeg before passing to whisper-cpp.
 *
 * @param audioBuffer - Audio data (WAV, webm, or ogg format)
 * @param config - Whisper configuration
 * @returns Transcription result
 */
export async function transcribeWithWhisper(
  audioBuffer: Buffer,
  config: LocalSttConfig,
): Promise<LocalSttResult> {
  const startTime = Date.now();

  // Detect format and convert if needed
  const prepResult = await prepareAudioForWhisper(audioBuffer);
  if (!prepResult.success || !prepResult.wav) {
    return {
      success: false,
      error: prepResult.error ?? "Audio preparation failed",
      latencyMs: Date.now() - startTime,
    };
  }

  // Create temp file for audio
  const tempDir = path.join(tmpdir(), "openclaw-stt");
  mkdirSync(tempDir, { recursive: true });
  const tempAudioPath = path.join(tempDir, `audio-${Date.now()}.wav`);

  try {
    writeFileSync(tempAudioPath, prepResult.wav);

    const result = await runWhisper(tempAudioPath, config);
    return {
      ...result,
      latencyMs: Date.now() - startTime,
      model: path.basename(config.modelPath),
    };
  } finally {
    // Cleanup temp file
    try {
      unlinkSync(tempAudioPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Transcribe audio file using whisper-cpp.
 */
export async function transcribeFileWithWhisper(
  audioPath: string,
  config: LocalSttConfig,
): Promise<LocalSttResult> {
  const startTime = Date.now();

  if (!existsSync(audioPath)) {
    return {
      success: false,
      error: `Audio file not found: ${audioPath}`,
      latencyMs: Date.now() - startTime,
    };
  }

  const result = await runWhisper(audioPath, config);
  return {
    ...result,
    latencyMs: Date.now() - startTime,
    model: path.basename(config.modelPath),
  };
}

function runWhisper(audioPath: string, config: LocalSttConfig): Promise<LocalSttResult> {
  const candidates = resolveWhisperBinaryCandidates(config.binaryPath);
  return runWhisperWithFallback(audioPath, config, candidates);
}

async function runWhisperWithFallback(
  audioPath: string,
  config: LocalSttConfig,
  candidates: string[],
): Promise<LocalSttResult> {
  let lastMissingBinaryError: string | null = null;
  for (const binaryPath of candidates) {
    const result = await runWhisperOnce(audioPath, { ...config, binaryPath });
    if (result.success) {
      return result;
    }
    const errorText = (result.error ?? "").toLowerCase();
    const missingBinary = errorText.includes("enoent") || errorText.includes("spawn ");
    if (!missingBinary) {
      return result;
    }
    lastMissingBinaryError = result.error ?? null;
  }

  return {
    success: false,
    error:
      lastMissingBinaryError ?? `Whisper failed: no executable found (${candidates.join(", ")})`,
  };
}

function runWhisperOnce(audioPath: string, config: LocalSttConfig): Promise<LocalSttResult> {
  return new Promise((resolve) => {
    const args = [
      "-m",
      config.modelPath,
      "-f",
      audioPath,
      "-l",
      config.language,
      "-t",
      String(config.threads),
      "--no-timestamps",
      "--output-txt",
    ];

    let stdout = "";
    let stderr = "";

    const proc = spawn(config.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.timeoutMs,
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        success: false,
        error: `Whisper transcription timed out after ${config.timeoutMs}ms`,
      });
    }, config.timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        error: `Whisper failed: ${err.message}`,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        resolve({
          success: false,
          error: `Whisper exited with code ${code}: ${stderr.trim()}`,
        });
        return;
      }

      // Parse whisper output - it outputs transcription to stdout
      let text = parseWhisperOutput(stdout);
      if (!text) {
        const txtPath = `${audioPath}.txt`;
        if (existsSync(txtPath)) {
          try {
            const txtOutput = readFileSync(txtPath, "utf-8");
            text = parseWhisperOutput(txtOutput);
          } finally {
            try {
              unlinkSync(txtPath);
            } catch {
              // Ignore cleanup errors
            }
          }
        }
      }
      if (!text) {
        resolve({
          success: false,
          error: "Whisper produced no transcription",
        });
        return;
      }

      resolve({
        success: true,
        text,
      });
    });
  });
}

/**
 * Parse whisper-cpp output to extract transcription text.
 * Whisper outputs timestamps and text, we want just the text.
 */
function parseWhisperOutput(output: string): string {
  const lines = output.split("\n");
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Skip timestamp lines like "[00:00:00.000 --> 00:00:02.000]"
    if (trimmed.startsWith("[") && trimmed.includes("-->")) {
      continue;
    }

    // Skip whisper info lines
    if (
      trimmed.startsWith("whisper_") ||
      trimmed.startsWith("main:") ||
      trimmed.startsWith("system_info:")
    ) {
      continue;
    }

    // Remove leading timestamp patterns like "00:00:00.000"
    const withoutTimestamp = trimmed.replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s*/, "");
    if (withoutTimestamp) {
      textLines.push(withoutTimestamp);
    }
  }

  return textLines.join(" ").trim();
}

/**
 * Detect audio format from buffer header.
 * Returns "wav", "webm", "ogg", or "unknown".
 */
export function detectAudioFormat(audioBuffer: Buffer): string {
  if (audioBuffer.length < 12) {
    return "unknown";
  }

  // WAV: starts with "RIFF" and contains "WAVE"
  if (
    audioBuffer[0] === 0x52 && // R
    audioBuffer[1] === 0x49 && // I
    audioBuffer[2] === 0x46 && // F
    audioBuffer[3] === 0x46 && // F
    audioBuffer[8] === 0x57 && // W
    audioBuffer[9] === 0x41 && // A
    audioBuffer[10] === 0x56 && // V
    audioBuffer[11] === 0x45 // E
  ) {
    return "wav";
  }

  // WebM/Matroska: starts with 0x1A 0x45 0xDF 0xA3
  if (
    audioBuffer[0] === 0x1a &&
    audioBuffer[1] === 0x45 &&
    audioBuffer[2] === 0xdf &&
    audioBuffer[3] === 0xa3
  ) {
    return "webm";
  }

  // OGG: starts with "OggS"
  if (
    audioBuffer[0] === 0x4f && // O
    audioBuffer[1] === 0x67 && // g
    audioBuffer[2] === 0x67 && // g
    audioBuffer[3] === 0x53 // S
  ) {
    return "ogg";
  }

  return "unknown";
}

/**
 * Convert audio to WAV format suitable for whisper-cpp using ffmpeg.
 * Whisper expects 16kHz mono WAV.
 *
 * @param audioBuffer - Input audio data (webm, ogg, or other format)
 * @param inputFormat - Format hint for the input (e.g., "webm", "ogg")
 * @returns WAV buffer at 16kHz mono
 */
export async function convertToWav(
  audioBuffer: Buffer,
  inputFormat: string,
): Promise<{ success: boolean; wav?: Buffer; error?: string }> {
  const tempDir = path.join(tmpdir(), "openclaw-stt");
  mkdirSync(tempDir, { recursive: true });

  const timestamp = Date.now();
  const tempInputPath = path.join(tempDir, `audio-in-${timestamp}.${inputFormat}`);
  const tempOutputPath = path.join(tempDir, `audio-out-${timestamp}.wav`);

  try {
    // Write input to temp file
    writeFileSync(tempInputPath, audioBuffer);

    // Convert using ffmpeg: 16kHz, mono, PCM s16le WAV
    await execFileAsync(
      "ffmpeg",
      [
        "-y", // Overwrite output
        "-i",
        tempInputPath,
        "-ar",
        "16000", // Sample rate
        "-ac",
        "1", // Mono
        "-c:a",
        "pcm_s16le", // PCM codec
        "-f",
        "wav", // WAV format
        tempOutputPath,
      ],
      {
        timeout: 30000,
      },
    );

    // Read the converted WAV
    const wav = readFileSync(tempOutputPath);
    return { success: true, wav };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Audio conversion failed: ${message}`,
    };
  } finally {
    // Cleanup temp files
    try {
      unlinkSync(tempInputPath);
    } catch {
      // Ignore
    }
    try {
      unlinkSync(tempOutputPath);
    } catch {
      // Ignore
    }
  }
}

/**
 * Check if ffmpeg is available for audio conversion.
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepare audio buffer for whisper-cpp.
 * Detects format and converts to 16kHz mono WAV if needed.
 */
export async function prepareAudioForWhisper(
  audioBuffer: Buffer,
): Promise<{ success: boolean; wav?: Buffer; error?: string }> {
  const format = detectAudioFormat(audioBuffer);

  // If already WAV, return as-is
  if (format === "wav") {
    return { success: true, wav: audioBuffer };
  }

  // Convert non-WAV formats using ffmpeg
  if (format === "webm" || format === "ogg") {
    return await convertToWav(audioBuffer, format);
  }

  // Unknown format - try to convert anyway, let ffmpeg figure it out
  if (format === "unknown") {
    // Try as webm first (most common from browsers)
    const result = await convertToWav(audioBuffer, "webm");
    if (result.success) {
      return result;
    }

    // Fall back to letting ffmpeg auto-detect
    return await convertToWav(audioBuffer, "bin");
  }

  return {
    success: false,
    error: `Unsupported audio format: ${format}`,
  };
}
