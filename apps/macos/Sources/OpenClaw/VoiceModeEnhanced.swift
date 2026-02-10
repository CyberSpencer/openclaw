import Foundation
import OSLog

/// Enhanced voice mode configuration supporting local STT/TTS and model routing.
///
/// This extends the existing TalkModeRuntime with:
/// - Local whisper-cpp STT support
/// - Model routing (sensitive data detection, complexity heuristics)
/// - PersonaPlex S2S experimental support
struct VoiceModeConfig {
    var mode: VoiceMode = .option2a
    var sttProvider: STTProvider = .apple
    var ttsProvider: TTSProvider = .elevenlabs
    var routerEnabled: Bool = true
    var routerMode: RouterMode = .auto
    var sensitiveDetection: Bool = true
    var complexityRouting: Bool = true
    var complexityThreshold: Int = 5
    var localModel: String = "llama3:8b"
    var personaplexEnabled: Bool = false
    var personaplexPort: Int = 8765
    var whisperModelPath: String = ""
    var whisperLanguage: String = "en"
}

enum VoiceMode: String, CaseIterable {
    case option2a = "option2a"  // Local STT/TTS with model routing
    case personaplex = "personaplex"  // Speech-to-Speech (experimental)
    case hybrid = "hybrid"  // Auto-select based on context
}

enum STTProvider: String, CaseIterable {
    case apple = "apple"  // Apple Speech framework
    case whisper = "whisper"  // Local whisper-cpp
    case openai = "openai"  // OpenAI Whisper API
}

enum TTSProvider: String, CaseIterable {
    case elevenlabs = "elevenlabs"  // ElevenLabs API
    case openai = "openai"  // OpenAI TTS
    case macos = "macos"  // macOS say command
    case edge = "edge"  // Edge TTS
}

enum RouterMode: String, CaseIterable {
    case local = "local"  // Always use local model
    case cloud = "cloud"  // Always use cloud model
    case auto = "auto"  // Smart routing based on content
}

/// Manages enhanced voice mode features.
@MainActor
@Observable
final class VoiceModeManager {
    static let shared = VoiceModeManager()

    private let logger = Logger(subsystem: "ai.openclaw", category: "voice.enhanced")

    private(set) var config: VoiceModeConfig = VoiceModeConfig()
    private(set) var isAvailable: Bool = false
    private(set) var whisperAvailable: Bool = false
    private(set) var personaplexAvailable: Bool = false
    private(set) var lastRouterDecision: RouterDecision?

    /// Load voice mode configuration from gateway.
    func loadConfig() async {
        do {
            // Use requestRaw with string method name for voice endpoints
            let configData = try await GatewayConnection.shared.requestRaw(
                method: "voice.config",
                params: nil,
                timeoutMs: 5000
            )

            if let configDict = try? JSONSerialization.jsonObject(with: configData) as? [String: Any] {
                self.parseConfig(configDict)
            }

            // Check capabilities
            let statusData = try await GatewayConnection.shared.requestRaw(
                method: "voice.status",
                params: nil,
                timeoutMs: 5000
            )

            if let statusDict = try? JSONSerialization.jsonObject(with: statusData) as? [String: Any] {
                self.parseStatus(statusDict)
            }

            self.logger.info("voice config loaded: mode=\(self.config.mode.rawValue, privacy: .public)")
        } catch {
            self.logger.error("voice config load failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func parseConfig(_ dict: [String: Any]) {
        if let mode = dict["mode"] as? String {
            self.config.mode = VoiceMode(rawValue: mode) ?? .option2a
        }
        if let stt = dict["sttProvider"] as? String {
            self.config.sttProvider = STTProvider(rawValue: stt) ?? .apple
        }
        if let tts = dict["ttsProvider"] as? String {
            self.config.ttsProvider = TTSProvider(rawValue: tts) ?? .elevenlabs
        }

        if let router = dict["router"] as? [String: Any] {
            if let mode = router["mode"] as? String {
                self.config.routerMode = RouterMode(rawValue: mode) ?? .auto
            }
            if let sensitive = router["detectSensitive"] as? Bool {
                self.config.sensitiveDetection = sensitive
            }
            if let complexity = router["useComplexity"] as? Bool {
                self.config.complexityRouting = complexity
            }
            if let threshold = router["complexityThreshold"] as? Int {
                self.config.complexityThreshold = threshold
            }
            if let local = router["localModel"] as? String {
                self.config.localModel = local
            }
        }

        if let personaplex = dict["personaplex"] as? [String: Any] {
            if let enabled = personaplex["enabled"] as? Bool {
                self.config.personaplexEnabled = enabled
            }
            if let port = personaplex["port"] as? Int {
                self.config.personaplexPort = port
            }
        }
    }

    private func parseStatus(_ dict: [String: Any]) {
        if let enabled = dict["enabled"] as? Bool {
            self.isAvailable = enabled
        }
        if let capabilities = dict["capabilities"] as? [String: Any] {
            self.whisperAvailable = capabilities["whisperAvailable"] as? Bool ?? false
            self.personaplexAvailable = capabilities["personaplexAvailable"] as? Bool ?? false
        }
    }

    /// Route a text prompt through the model router.
    func routePrompt(_ text: String) async -> RouterDecision {
        let decision: RouterDecision

        // If router is disabled, use default behavior
        guard config.routerEnabled else {
            decision = RouterDecision(
                route: .cloud,
                reason: "router disabled",
                sensitiveDetected: false,
                complexityScore: 0,
                model: nil
            )
            self.lastRouterDecision = decision
            return decision
        }

        // Call gateway router endpoint
        do {
            let data = try await GatewayConnection.shared.requestRaw(
                method: "voice.route",
                params: ["text": AnyCodable(text)],
                timeoutMs: 2000
            )

            if let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let route = (dict["route"] as? String) == "local" ? RouteType.local : RouteType.cloud
                decision = RouterDecision(
                    route: route,
                    reason: dict["reason"] as? String ?? "gateway decision",
                    sensitiveDetected: dict["sensitiveDetected"] as? Bool ?? false,
                    complexityScore: dict["complexityScore"] as? Int ?? 0,
                    model: dict["model"] as? String
                )
            } else {
                decision = RouterDecision(
                    route: .cloud,
                    reason: "parse error",
                    sensitiveDetected: false,
                    complexityScore: 0,
                    model: nil
                )
            }
        } catch {
            self.logger.error("router request failed: \(error.localizedDescription, privacy: .public)")
            decision = RouterDecision(
                route: .cloud,
                reason: "error: \(error.localizedDescription)",
                sensitiveDetected: false,
                complexityScore: 0,
                model: nil
            )
        }

        self.lastRouterDecision = decision
        self.logger.info("router decision: route=\(decision.route.rawValue, privacy: .public) reason=\(decision.reason, privacy: .public)")
        return decision
    }

    /// Synthesize speech using local TTS via gateway.
    func synthesizeSpeech(_ text: String) async -> SynthesisResult? {
        do {
            let data = try await GatewayConnection.shared.requestRaw(
                method: "voice.synthesize",
                params: ["text": AnyCodable(text)],
                timeoutMs: 30000
            )

            if let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return SynthesisResult(
                    audioBase64: dict["audioBase64"] as? String,
                    provider: dict["provider"] as? String ?? "unknown",
                    latencyMs: dict["latencyMs"] as? Int,
                    warning: dict["warning"] as? String
                )
            }
        } catch {
            self.logger.error("synthesis failed: \(error.localizedDescription, privacy: .public)")
        }
        return nil
    }

    /// Transcribe audio using local STT via gateway.
    func transcribeAudio(_ audioBase64: String) async -> String? {
        do {
            let data = try await GatewayConnection.shared.requestRaw(
                method: "voice.transcribe",
                params: ["audio": AnyCodable(audioBase64)],
                timeoutMs: 30000
            )

            if let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return dict["text"] as? String
            }
        } catch {
            self.logger.error("transcription failed: \(error.localizedDescription, privacy: .public)")
        }
        return nil
    }
}

// MARK: - Types

enum RouteType: String {
    case local
    case cloud
}

struct RouterDecision {
    let route: RouteType
    let reason: String
    let sensitiveDetected: Bool
    let complexityScore: Int
    let model: String?
}

struct SynthesisResult {
    let audioBase64: String?
    let provider: String
    let latencyMs: Int?
    let warning: String?
}

// Note: Voice methods use GatewayConnection.shared.requestRaw(method: String, ...)
// directly instead of the Method enum, since voice.* methods are not in the enum.
