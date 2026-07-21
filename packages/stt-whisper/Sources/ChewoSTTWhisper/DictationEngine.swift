import Foundation
import WhisperKit

/// Streaming transcription engine ported from the WhisperKitDictation
/// prototype's confirm-and-seek scheme: rather than re-decoding the whole
/// buffer on every pass (O(n²) over a long session), settled segments are
/// confirmed once and only the audio after the last confirmed segment is
/// re-decoded, via `clipTimestamps`. Per-pass cost stays bounded by the
/// unconfirmed tail. The trailing 2 segments are always re-decoded next pass
/// so text stabilizes before it is committed.
///
/// Long sessions (meetings, online lessons) stay flat on memory and CPU:
/// once audio is confirmed it is dropped from the rolling `SampleBuffer`,
/// and confirmed text is built incrementally — never re-rendered — so both
/// per-pass work and resident audio are bounded by the unconfirmed tail,
/// not the session length. Positions are absolute since capture start; the
/// decoder sees window-relative times (window start = dropped audio).
actor DictationEngine {
    /// Capture is deliberately decoupled from the model: the source records
    /// into a rolling buffer, so audio accumulates while WhisperKit is still
    /// loading (SPEC-TODOS §6 capture-before-ready) and transcription simply
    /// begins once the model lands.
    private var capture: CaptureSource?
    private var whisperKit: WhisperKit?
    private var loadedModelName: String?

    private var lastTranscribedSampleCount = 0
    private var lastConfirmedSegmentEndSeconds: Float = 0
    private let requiredSegmentsForConfirmation = 2

    // Incremental confirmed text + the paragraphing state needed to extend
    // it, so no pass ever touches more than the newly confirmed segments.
    private var confirmedText = ""
    private var previousConfirmedEnd: Float?
    private var sentencesSinceBreak = 0

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

    func startRecording(kind: CaptureKind) throws {
        resetStreamingState()
        let source = try makeCapture(kind)
        try source.start()
        capture = source
    }

    func stopRecording() {
        capture?.stop()
    }

    /// Latest capture energy, 0…1 — drives the level meter.
    func level() -> Double {
        capture?.level() ?? 0
    }

    func reset() {
        resetStreamingState()
        capture = nil
    }

    private func resetStreamingState() {
        lastTranscribedSampleCount = 0
        lastConfirmedSegmentEndSeconds = 0
        confirmedText = ""
        previousConfirmedEnd = nil
        sentencesSinceBreak = 0
    }

    func transcribeCurrentBuffer(minimumNewSamples: Int) async throws -> Update? {
        // Model still loading — keep buffering; this pass becomes a no-op.
        guard let whisperKit, let capture else {
            return nil
        }

        let (samples, startSample) = capture.buffer.snapshot()
        let absoluteSampleCount = startSample + samples.count
        let newSampleCount = absoluteSampleCount - lastTranscribedSampleCount
        guard absoluteSampleCount >= WhisperKit.sampleRate, newSampleCount >= minimumNewSamples
        else {
            return nil
        }

        lastTranscribedSampleCount = absoluteSampleCount

        // The window starts where dropped (confirmed) audio ends; seek past
        // whatever confirmed audio is still resident. Timestamps are
        // required for segment start/end.
        let windowStartSeconds = Float(startSample) / Float(WhisperKit.sampleRate)
        let clipStart = max(0, lastConfirmedSegmentEndSeconds - windowStartSeconds)
        let options = DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: "en",
            temperature: 0,
            skipSpecialTokens: true,
            withoutTimestamps: false,
            wordTimestamps: false,
            clipTimestamps: [clipStart],
            concurrentWorkerCount: 4,
            chunkingStrategy: ChunkingStrategy.none
        )

        let results = try await whisperKit.transcribe(
            audioArray: samples,
            decodeOptions: options
        )

        // Segment times come back relative to the window's start.
        let freshSegments = results
            .flatMap(\.segments)
            .sorted { $0.start < $1.start }

        let unconfirmedSegments = confirm(freshSegments, windowStartSeconds: windowStartSeconds)

        // Confirmed audio is settled — drop it so the resident window (and
        // the array copied each pass) stays bounded by the unconfirmed tail.
        let confirmedSample = Int(lastConfirmedSegmentEndSeconds * Float(WhisperKit.sampleRate))
        capture.buffer.drop(through: confirmedSample)

        // Paragraphs only in confirmed text: it is append-only, so breaks are
        // stable. The tail is re-decoded every pass and Whisper re-segments
        // inconsistently — structure shown there would flicker and vanish.
        return Update(
            confirmedText: confirmedText,
            tailText: plainText(of: unconfirmedSegments),
            durationSeconds: Double(absoluteSampleCount) / Double(WhisperKit.sampleRate)
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

    /// Extends the confirmed text with one newly settled segment.
    /// Deterministic over an append-only stream, so breaks never move: a
    /// break lands on a real pause, or after `maxSentencesPerParagraph`
    /// sentences once the previous segment ended a sentence.
    private func appendConfirmed(_ segment: TranscriptionSegment, windowStartSeconds: Float) {
        let piece = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !piece.isEmpty else { return }
        let start = segment.start + windowStartSeconds
        let end = segment.end + windowStartSeconds
        if let previousConfirmedEnd {
            let longPause = start - previousConfirmedEnd > paragraphGapSeconds
            let sentenceBudgetSpent =
                sentencesSinceBreak >= maxSentencesPerParagraph && endsSentence(confirmedText)
            if longPause || sentenceBudgetSpent {
                confirmedText += "\n\n"
                sentencesSinceBreak = 0
            } else if !confirmedText.isEmpty {
                confirmedText += " "
            }
        } else if !confirmedText.isEmpty {
            confirmedText += " "
        }
        confirmedText += piece
        sentencesSinceBreak += piece.filter { ".!?".contains($0) }.count
        previousConfirmedEnd = end
    }

    private func endsSentence(_ text: String) -> Bool {
        guard let last = text.last else { return false }
        return ".!?".contains(last)
    }

    /// Promotes all but the trailing `requiredSegmentsForConfirmation`
    /// segments into the confirmed text, advancing the seek point. Returns
    /// the segments still considered in-flight (re-decoded next pass).
    private func confirm(
        _ segments: [TranscriptionSegment], windowStartSeconds: Float
    ) -> [TranscriptionSegment] {
        guard segments.count > requiredSegmentsForConfirmation else {
            return segments
        }

        let confirmable = Array(segments.dropLast(requiredSegmentsForConfirmation))
        let remaining = Array(segments.suffix(requiredSegmentsForConfirmation))

        if let last = confirmable.last,
           last.end + windowStartSeconds > lastConfirmedSegmentEndSeconds {
            lastConfirmedSegmentEndSeconds = last.end + windowStartSeconds
            for segment in confirmable {
                appendConfirmed(segment, windowStartSeconds: windowStartSeconds)
            }
        }

        return remaining
    }
}
