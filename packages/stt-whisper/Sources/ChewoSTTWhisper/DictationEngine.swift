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
    /// Capture is deliberately decoupled from the model: the mic records into
    /// this standalone processor, so audio buffers while WhisperKit is still
    /// loading (SPEC-TODOS §6 capture-before-ready) and transcription simply
    /// begins once the model lands.
    private let audioProcessor = AudioProcessor()
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
        whisperKit = try await WhisperKit(
            model: modelName,
            verbose: false,
            prewarm: true,
            load: true,
            download: true
        )
        loadedModelName = modelName
    }

    func isLoaded(_ modelName: String) -> Bool {
        whisperKit != nil && loadedModelName == modelName
    }

    /// Frees the model (~1–1.5 GB for large-v3-turbo) after idle; the next
    /// start reloads it while capture buffers.
    func unload() {
        whisperKit = nil
        loadedModelName = nil
        resetStreamingState()
    }

    func requestMicrophonePermission() async -> Bool {
        await AudioProcessor.requestRecordPermission()
    }

    func startRecording() throws {
        resetStreamingState()
        try audioProcessor.startRecordingLive(inputDeviceID: nil) { _ in }
    }

    func stopRecording() {
        audioProcessor.stopRecording()
    }

    /// Latest mic energy, 0…1 — drives the level meter.
    func level() -> Double {
        Double(audioProcessor.relativeEnergy.last ?? 0)
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
        // Model still loading — keep buffering; this pass becomes a no-op.
        guard let whisperKit else {
            return nil
        }

        let samples = Array(audioProcessor.audioSamples)
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

        // Paragraphs only in confirmed text: it is append-only, so breaks are
        // stable. The tail is re-decoded every pass and Whisper re-segments
        // inconsistently — structure shown there would flicker and vanish.
        return Update(
            confirmedText: paragraphedText(of: confirmedSegments),
            tailText: plainText(of: unconfirmedSegments),
            durationSeconds: Double(samples.count) / Double(WhisperKit.sampleRate)
        )
    }

    /// A silence gap between segments longer than this starts a new paragraph.
    private let paragraphGapSeconds: Float = 1.75
    /// Continuous speakers rarely pause that long — fall back to breaking
    /// after this many sentences, at a sentence boundary.
    private let maxSentencesPerParagraph = 4

    private func plainText(of segments: [TranscriptionSegment]) -> String {
        segments
            .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// Deterministic over an append-only segment list, so breaks never move:
    /// a break lands on a real pause, or after `maxSentencesPerParagraph`
    /// sentences once the previous segment ended a sentence.
    private func paragraphedText(of segments: [TranscriptionSegment]) -> String {
        var text = ""
        var previousEnd: Float?
        var sentencesSinceBreak = 0
        for segment in segments {
            let piece = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !piece.isEmpty else { continue }
            if let previousEnd {
                let longPause = segment.start - previousEnd > paragraphGapSeconds
                let sentenceBudgetSpent =
                    sentencesSinceBreak >= maxSentencesPerParagraph && endsSentence(text)
                if longPause || sentenceBudgetSpent {
                    text += "\n\n"
                    sentencesSinceBreak = 0
                } else {
                    text += " "
                }
            }
            text += piece
            sentencesSinceBreak += piece.filter { ".!?".contains($0) }.count
            previousEnd = segment.end
        }
        return text
    }

    private func endsSentence(_ text: String) -> Bool {
        guard let last = text.last else { return false }
        return ".!?".contains(last)
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
