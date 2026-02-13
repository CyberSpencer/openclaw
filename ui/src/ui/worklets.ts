declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

function normalizeBasePath(input?: string): string {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  let normalized = trimmed;
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized === "/") {
    return "";
  }
  return normalized.replace(/\/+$/, "");
}

export function buildWorkletModuleUrl(
  fileName: string,
  version: string,
  explicitBasePath?: string,
): string {
  const basePath =
    explicitBasePath ??
    (typeof window !== "undefined" ? window.__OPENCLAW_CONTROL_UI_BASE_PATH__ : undefined);
  const normalizedBase = normalizeBasePath(basePath);
  const safeFileName = fileName.replace(/^\/+/, "");
  const prefix = normalizedBase ? `${normalizedBase}/` : "/";
  const versionSuffix = version ? `?v=${encodeURIComponent(version)}` : "";
  return `${prefix}worklets/${safeFileName}${versionSuffix}`;
}

export function supportsAudioWorkletRuntime(): boolean {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    typeof AudioContext === "undefined" ||
    typeof AudioWorkletNode === "undefined"
  ) {
    return false;
  }
  return "audioWorklet" in AudioContext.prototype;
}
