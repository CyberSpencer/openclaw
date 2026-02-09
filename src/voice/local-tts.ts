/**
 * Local TTS (Text-to-Speech) using ElevenLabs sag CLI with macOS fallback.
 *
 * Uses the `sag` CLI (ElevenLabs) for high-quality TTS, with automatic
 * fallback to macOS `say` command when sag is unavailable or fails.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { VoiceLocalTtsConfig } from "../config/types.voice.js";

const DEFAULT_SAG_VOICE_ID = "pMsXgVXv3BLzUgSXRplE"; // Adam (default ElevenLabs voice)
const DEFAULT_SAG_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_MACOS_VOICE = "Samantha";
const DEFAULT_TIMEOUT_MS = 30_000;

export type LocalTtsResult = {
  success: boolean;
  audioPath?: string;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider: "sag" | "macos";
  warning?: string;
};

export type LocalTtsConfig = Required<VoiceLocalTtsConfig>;

export function resolveLocalTtsConfig(config?: VoiceLocalTtsConfig): LocalTtsConfig {
  return {
    useSag: config?.useSag ?? true,
    voiceId: config?.voiceId?.trim() || DEFAULT_SAG_VOICE_ID,
    modelId: config?.modelId?.trim() || DEFAULT_SAG_MODEL_ID,
    fallbackToMacos: config?.fallbackToMacos ?? true,
    macosVoice: config?.macosVoice?.trim() || DEFAULT_MACOS_VOICE,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Check if sag CLI is available and authenticated.
 */
export async function isSagAvailable(): Promise<{ available: boolean; authenticated: boolean }> {
  try {
    // Check if sag is in PATH
    execSync("which sag", { stdio: "ignore" });

    // Check if sag is authenticated by listing voices
    const result = await runCommand("sag", ["voices", "--json"], 5000);
    if (result.exitCode === 0) {
      return { available: true, authenticated: true };
    }

    // sag exists but may not be authenticated
    return { available: true, authenticated: false };
  } catch {
    return { available: false, authenticated: false };
  }
}

/**
 * Check if macOS say command is available.
 */
export function isMacosSayAvailable(): boolean {
  try {
    execSync("which say", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Synthesize speech from text using local TTS.
 *
 * @param text - Text to convert to speech
 * @param config - TTS configuration
 * @returns TTS result with audio path or buffer
 */
export async function synthesizeWithLocalTts(
  text: string,
  config: LocalTtsConfig,
): Promise<LocalTtsResult> {
  const startTime = Date.now();

  // Try sag first if enabled
  if (config.useSag) {
    const sagResult = await synthesizeWithSag(text, config);
    if (sagResult.success) {
      return {
        ...sagResult,
        latencyMs: Date.now() - startTime,
      };
    }

    // Log sag failure for debugging
    const warning = `sag failed: ${sagResult.error}`;

    // Fall back to macOS if enabled
    if (config.fallbackToMacos) {
      const macosResult = await synthesizeWithMacos(text, config);
      return {
        ...macosResult,
        latencyMs: Date.now() - startTime,
        warning,
      };
    }

    return {
      ...sagResult,
      latencyMs: Date.now() - startTime,
    };
  }

  // Use macOS directly if sag is disabled
  if (config.fallbackToMacos) {
    const macosResult = await synthesizeWithMacos(text, config);
    return {
      ...macosResult,
      latencyMs: Date.now() - startTime,
    };
  }

  return {
    success: false,
    error: "No TTS provider available",
    provider: "sag",
    latencyMs: Date.now() - startTime,
  };
}

/**
 * Synthesize speech using ElevenLabs sag CLI.
 */
async function synthesizeWithSag(text: string, config: LocalTtsConfig): Promise<LocalTtsResult> {
  const tempDir = path.join(tmpdir(), "openclaw-tts");
  mkdirSync(tempDir, { recursive: true });
  const outputPath = path.join(tempDir, `tts-${Date.now()}.mp3`);

  const args = [
    "tts",
    "--voice-id",
    config.voiceId,
    "--model-id",
    config.modelId,
    "--output",
    outputPath,
    text,
  ];

  const result = await runCommand("sag", args, config.timeoutMs);

  if (result.exitCode !== 0) {
    // Clean up failed output
    try {
      unlinkSync(outputPath);
    } catch {
      // Ignore
    }

    // Parse sag error
    const errorMsg = result.stderr.trim() || result.stdout.trim() || `Exit code ${result.exitCode}`;
    return {
      success: false,
      error: errorMsg,
      provider: "sag",
    };
  }

  // Verify output file exists
  if (!existsSync(outputPath)) {
    return {
      success: false,
      error: "sag did not produce output file",
      provider: "sag",
    };
  }

  return {
    success: true,
    audioPath: outputPath,
    audioBuffer: readFileSync(outputPath),
    provider: "sag",
  };
}

/**
 * Synthesize speech using macOS say command directly.
 * Exported for direct use when ttsProvider is explicitly "macos".
 * Converts AIFF output to WAV for browser compatibility.
 */
export async function synthesizeWithMacos(
  text: string,
  config: LocalTtsConfig,
): Promise<LocalTtsResult> {
  if (!isMacosSayAvailable()) {
    return {
      success: false,
      error: "macOS say command not available",
      provider: "macos",
    };
  }

  const tempDir = path.join(tmpdir(), "openclaw-tts");
  mkdirSync(tempDir, { recursive: true });
  const aiffPath = path.join(tempDir, `tts-${Date.now()}.aiff`);
  const wavPath = path.join(tempDir, `tts-${Date.now()}.wav`);

  const args = ["-v", config.macosVoice, "-o", aiffPath, text];

  const result = await runCommand("say", args, config.timeoutMs);

  if (result.exitCode !== 0) {
    // Clean up failed output
    try {
      unlinkSync(aiffPath);
    } catch {
      // Ignore
    }

    return {
      success: false,
      error: result.stderr.trim() || `say exited with code ${result.exitCode}`,
      provider: "macos",
    };
  }

  // Verify output file exists
  if (!existsSync(aiffPath)) {
    return {
      success: false,
      error: "say did not produce output file",
      provider: "macos",
    };
  }

  // Convert AIFF to WAV for browser compatibility
  let converted =
    (
      await runCommand(
        "ffmpeg",
        ["-y", "-i", aiffPath, "-ar", "44100", "-ac", "1", "-f", "wav", wavPath],
        config.timeoutMs,
      )
    ).exitCode === 0 && existsSync(wavPath);

  if (!converted) {
    // Fallback: try afconvert if ffmpeg fails
    const afconvertResult = await runCommand(
      "afconvert",
      ["-f", "WAVE", "-d", "LEI16@44100", aiffPath, wavPath],
      config.timeoutMs,
    );

    converted = afconvertResult.exitCode === 0 && existsSync(wavPath);
  }

  // Clean up AIFF file after conversion attempts
  try {
    unlinkSync(aiffPath);
  } catch {
    // Ignore
  }

  if (!converted) {
    return {
      success: false,
      error: "Failed to convert audio to WAV format",
      provider: "macos",
    };
  }

  return {
    success: true,
    audioPath: wavPath,
    audioBuffer: readFileSync(wavPath),
    provider: "macos",
  };
}

/**
 * Run a command with timeout.
 */
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        exitCode: -1,
        stdout,
        stderr: `Command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: err.message,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Clean up temporary TTS files older than 5 minutes.
 */
export function cleanupTtsCache(): number {
  const tempDir = path.join(tmpdir(), "openclaw-tts");
  if (!existsSync(tempDir)) {
    return 0;
  }

  const { readdirSync, statSync } = require("node:fs");
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  let cleaned = 0;

  try {
    const files = readdirSync(tempDir);
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < fiveMinutesAgo) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Ignore individual file errors
      }
    }
  } catch {
    // Ignore directory errors
  }

  return cleaned;
}
