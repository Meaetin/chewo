import Foundation
import WhisperKit

/// Streaming transcription engine ported from the WhisperKitDictation
/// prototype's confirm-and-seek scheme: rather than re-decoding the whole
/// buffer on every pass (O(n²) over a long session), settled segments are
/// confirmed once and only the audio after the last confirmed segment is
/// re-decoded, via `clipTimestamps`. Per-pass cost stays bounded by the
/// unconfirmed tail. The trailing 2 segments are always re-decoded next pass
/// so text stabilizes before it is committed.
actor DictationEngine {
    private var whisperKit: WhisperKit?
    private var loadedModelName: String?

    private var lastTranscribedSampleCount = 0
    private var confirmedSegments: [TranscriptionSegment] = []
    private var lastConfirmedSegmentEndSeconds: Float = 0
    private let requiredSegmentsForConfirmation = 2

    struct Update: Sendable {
        let confirmedText: String
        let tailText: String
        let durationSeconds: Double
    }

    func load(modelName: String) async throws {
        if loadedModelName == modelName, whisperKit != nil {
            return
        }
        stopRecording()
        resetStreamingState()
        whisperKit = try await WhisperKit(
            model: modelName,
            verbose: false,
            prewarm: true,
            load: true,
            download: true
        )
        loadedModelName = modelName
    }

    func requestMicrophonePermission() async -> Bool {
        await AudioProcessor.requestRecordPermission()
    }

    func startRecording() throws {
        guard let whisperKit else {
            throw EngineError.modelNotLoaded
        }
        resetStreamingState()
        try whisperKit.audioProcessor.startRecordingLive(inputDeviceID: nil) { _ in }
    }

    func stopRecording() {
        whisperKit?.audioProcessor.stopRecording()
    }

    /// Latest mic energy, 0…1 — drives the level meter.
    func level() -> Double {
        Double(whisperKit?.audioProcessor.relativeEnergy.last ?? 0)
    }

    func reset() {
        resetStreamingState()
    }

    private func resetStreamingState() {
        lastTranscribedSampleCount = 0
        confirmedSegments.removeAll()
        lastConfirmedSegmentEndSeconds = 0
    }

    func transcribeCurrentBuffer(minimumNewSamples: Int) async throws -> Update? {
        guard let whisperKit else {
            throw EngineError.modelNotLoaded
        }

        let samples = Array(whisperKit.audioProcessor.audioSamples)
        let newSampleCount = samples.count - lastTranscribedSampleCount
        guard samples.count >= WhisperKit.sampleRate, newSampleCount >= minimumNewSamples else {
            return nil
        }

        lastTranscribedSampleCount = samples.count

        // Seek past already-confirmed audio so the decoder only processes the
        // unconfirmed tail. Timestamps are required for segment start/end.
        let options = DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: "en",
            temperature: 0,
            skipSpecialTokens: true,
            withoutTimestamps: false,
            wordTimestamps: false,
            clipTimestamps: [lastConfirmedSegmentEndSeconds],
            concurrentWorkerCount: 4,
            chunkingStrategy: ChunkingStrategy.none
        )

        let results = try await whisperKit.transcribe(
            audioArray: samples,
            decodeOptions: options
        )

        let freshSegments = results
            .flatMap(\.segments)
            .sorted { $0.start < $1.start }

        let unconfirmedSegments = confirm(freshSegments)

        return Update(
            confirmedText: joinedText(of: confirmedSegments),
            tailText: joinedText(of: unconfirmedSegments),
            durationSeconds: Double(samples.count) / Double(WhisperKit.sampleRate)
        )
    }

    private func joinedText(of segments: [TranscriptionSegment]) -> String {
        segments
            .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Promotes all but the trailing `requiredSegmentsForConfirmation` segments
    /// into `confirmedSegments`, advancing the seek point. Returns the segments
    /// still considered in-flight (re-decoded next pass).
    private func confirm(_ segments: [TranscriptionSegment]) -> [TranscriptionSegment] {
        guard segments.count > requiredSegmentsForConfirmation else {
            return segments
        }

        let confirmable = Array(segments.dropLast(requiredSegmentsForConfirmation))
        let remaining = Array(segments.suffix(requiredSegmentsForConfirmation))

        if let last = confirmable.last, last.end > lastConfirmedSegmentEndSeconds {
            lastConfirmedSegmentEndSeconds = last.end
            confirmedSegments.append(contentsOf: confirmable)
        }

        return remaining
    }
}

enum EngineError: LocalizedError {
    case modelNotLoaded

    var errorDescription: String? {
        switch self {
        case .modelNotLoaded:
            return "Load a Whisper model before recording."
        }
    }
}
