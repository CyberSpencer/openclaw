import SwiftUI

/// Settings view for enhanced voice mode configuration.
struct VoiceModeSettingsView: View {
    @Environment(VoiceModeManager.self) private var voiceManager

    @State private var mode: VoiceMode = .option2a
    @State private var sttProvider: STTProvider = .apple
    @State private var ttsProvider: TTSProvider = .elevenlabs
    @State private var routerEnabled: Bool = true
    @State private var routerMode: RouterMode = .auto
    @State private var sensitiveDetection: Bool = true
    @State private var complexityRouting: Bool = true
    @State private var complexityThreshold: Double = 5
    @State private var localModel: String = "llama3:8b"
    @State private var personaplexEnabled: Bool = false
    @State private var syncingFromManager = false

    var body: some View {
        Form {
            Section("Voice Mode") {
                Picker("Mode", selection: $mode) {
                    Text("Spark (DGX Voice)").tag(VoiceMode.spark)
                    Text("Option 2A (Local STT/TTS)").tag(VoiceMode.option2a)
                    Text("PersonaPlex S2S (Experimental)").tag(VoiceMode.personaplex)
                    Text("Hybrid (Auto-select)").tag(VoiceMode.hybrid)
                }
                .pickerStyle(.menu)

                Text(modeDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Speech-to-Text") {
                Picker("Provider", selection: $sttProvider) {
                    Text("Apple Speech").tag(STTProvider.apple)
                    Text("Whisper (Local)").tag(STTProvider.whisper)
                    Text("OpenAI Whisper").tag(STTProvider.openai)
                }
                .pickerStyle(.menu)

                if sttProvider == .whisper {
                    HStack {
                        Text("Status:")
                        if voiceManager.whisperAvailable {
                            Label("Available", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Label("Not Available", systemImage: "xmark.circle.fill")
                                .foregroundStyle(.red)
                        }
                    }
                }
            }

            Section("Text-to-Speech") {
                Picker("Provider", selection: $ttsProvider) {
                    Text("ElevenLabs").tag(TTSProvider.elevenlabs)
                    Text("OpenAI").tag(TTSProvider.openai)
                    Text("macOS (say)").tag(TTSProvider.macos)
                    Text("Edge TTS").tag(TTSProvider.edge)
                }
                .pickerStyle(.menu)
            }

            Section("Model Router") {
                Toggle("Enable Router", isOn: $routerEnabled)

                if routerEnabled {
                    Picker("Mode", selection: $routerMode) {
                        Text("Auto (Smart Routing)").tag(RouterMode.auto)
                        Text("Local Only").tag(RouterMode.local)
                        Text("Cloud Only").tag(RouterMode.cloud)
                    }
                    .pickerStyle(.menu)

                    if routerMode == .auto {
                        Toggle("Detect Sensitive Data", isOn: $sensitiveDetection)
                        Toggle("Use Complexity Heuristics", isOn: $complexityRouting)

                        if complexityRouting {
                            VStack(alignment: .leading) {
                                Text("Complexity Threshold: \(Int(complexityThreshold))")
                                Slider(value: $complexityThreshold, in: 1...10, step: 1)
                            }
                        }
                    }

                    TextField("Local Model", text: $localModel)
                        .textFieldStyle(.roundedBorder)
                }
            }

            Section("PersonaPlex S2S (Experimental)") {
                Toggle("Enable PersonaPlex", isOn: $personaplexEnabled)

                if personaplexEnabled {
                    HStack {
                        Text("Status:")
                        if voiceManager.personaplexAvailable {
                            Label("Available", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Label("Not Available", systemImage: "xmark.circle.fill")
                                .foregroundStyle(.red)
                        }
                    }

                    Text("PersonaPlex provides end-to-end speech-to-speech processing using NVIDIA's model. Requires GPU (MPS) and significant memory.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let lastDecision = voiceManager.lastRouterDecision {
                Section("Last Router Decision") {
                    LabeledContent("Route", value: lastDecision.route.rawValue.capitalized)
                    LabeledContent("Reason", value: lastDecision.reason)
                    if lastDecision.sensitiveDetected {
                        Label("Sensitive data detected", systemImage: "exclamationmark.shield.fill")
                            .foregroundStyle(.yellow)
                    }
                    if lastDecision.complexityScore > 0 {
                        LabeledContent("Complexity Score", value: "\(lastDecision.complexityScore)/10")
                    }
                    if let model = lastDecision.model {
                        LabeledContent("Model", value: model)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Voice Mode")
        .onAppear {
            loadFromManager()
        }
        .task {
            await voiceManager.loadConfig()
            loadFromManager()
        }
        .onChange(of: mode) { _, _ in syncToManager() }
        .onChange(of: sttProvider) { _, _ in syncToManager() }
        .onChange(of: ttsProvider) { _, _ in syncToManager() }
        .onChange(of: routerEnabled) { _, _ in syncToManager() }
        .onChange(of: routerMode) { _, _ in syncToManager() }
        .onChange(of: sensitiveDetection) { _, _ in syncToManager() }
        .onChange(of: complexityRouting) { _, _ in syncToManager() }
        .onChange(of: complexityThreshold) { _, _ in syncToManager() }
        .onChange(of: localModel) { _, _ in syncToManager() }
        .onChange(of: personaplexEnabled) { _, _ in syncToManager() }
    }

    private var modeDescription: String {
        switch mode {
        case .spark:
            return "Uses DGX Spark STT/TTS services as the primary voice pipeline."
        case .option2a:
            return "Uses local whisper-cpp for speech recognition and ElevenLabs for synthesis. Routes requests through the model router."
        case .personaplex:
            return "Uses NVIDIA PersonaPlex for end-to-end speech-to-speech processing. Experimental, requires GPU."
        case .hybrid:
            return "Automatically selects between Option 2A and PersonaPlex based on context and available resources."
        }
    }

    private func loadFromManager() {
        syncingFromManager = true
        mode = voiceManager.config.mode
        sttProvider = voiceManager.config.sttProvider
        ttsProvider = voiceManager.config.ttsProvider
        routerEnabled = voiceManager.config.routerEnabled
        routerMode = voiceManager.config.routerMode
        sensitiveDetection = voiceManager.config.sensitiveDetection
        complexityRouting = voiceManager.config.complexityRouting
        complexityThreshold = Double(voiceManager.config.complexityThreshold)
        localModel = voiceManager.config.localModel
        personaplexEnabled = voiceManager.config.personaplexEnabled
        syncingFromManager = false
    }

    private func syncToManager() {
        guard !syncingFromManager else { return }
        voiceManager.updateConfig { cfg in
            cfg.mode = mode
            cfg.sttProvider = sttProvider
            cfg.ttsProvider = ttsProvider
            cfg.routerEnabled = routerEnabled
            cfg.routerMode = routerMode
            cfg.sensitiveDetection = sensitiveDetection
            cfg.complexityRouting = complexityRouting
            cfg.complexityThreshold = Int(complexityThreshold)
            cfg.localModel = localModel
            cfg.personaplexEnabled = personaplexEnabled
        }
    }
}

#Preview {
    VoiceModeSettingsView()
        .environment(VoiceModeManager.shared)
        .frame(width: 400, height: 600)
}
