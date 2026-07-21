import Foundation

/// Headless STT sidecar for Chewo (SPEC-NOTES.md §6, SPEC-TODOS.md §6):
/// JSON-lines over stdio.
///
/// stdin:  {"cmd":"start","model":"openai_whisper-large-v3-v20240930_turbo","source":"mic"}
///           source: "mic" (default, dictation) | "mix" (device output + mic)
///           | "system" (device output only) — mix/system need macOS 14.2+
///           and the System Audio Recording permission
///         {"cmd":"stop"}   {"cmd":"prewarm","model":"…"}   {"cmd":"unload"}
///         {"cmd":"shutdown"}
/// stdout: {"event":"loading"} {"event":"ready"} {"event":"level","rms":0.3}
///         {"event":"partial","confirmed":"…","tail":"…"}
///         {"event":"final","text":"…","duration_s":12.4}
///         {"event":"prewarmed"} {"event":"unloaded"}
///         {"event":"error","message":"…"}
///
/// Capture-before-ready: `start` opens the mic immediately and emits `ready`;
/// if the model is still loading it also emits `loading`, audio buffers, and
/// transcription catches up once the load lands — so short utterances that
/// end before the model is ready still transcribe fully on `stop`.

struct Command: Decodable {
    let cmd: String
    let model: String?
    let source: String?
}

struct Event: Encodable, Sendable {
    var event: String
    var rms: Double? = nil
    var confirmed: String? = nil
    var tail: String? = nil
    var text: String? = nil
    var duration_s: Double? = nil
    var message: String? = nil
}

/// All stdout writes funnel through one actor so concurrent loops never
/// interleave half-lines.
actor Emitter {
    private let encoder = JSONEncoder()

    func send(_ event: Event) {
        guard let data = try? encoder.encode(event),
              let line = String(data: data, encoding: .utf8)
        else { return }
        print(line)
        fflush(stdout)
    }
}

actor Controller {
    private let engine = DictationEngine()
    private let out: Emitter
    private var levelTask: Task<Void, Never>?
    private var transcribeTask: Task<Void, Never>?
    private var loadTask: Task<Bool, Never>?
    private var recording = false
    private var lastConfirmed = ""
    private var lastTail = ""
    private var lastDuration: Double = 0

    init(out: Emitter) {
        self.out = out
    }

    /// One load in flight at a time; concurrent callers await the same task.
    private func sharedLoad(model: String) async -> Bool {
        if let task = loadTask {
            return await task.value
        }
        let task = Task { [engine, out] () -> Bool in
            do {
                try await engine.load(modelName: model)
                return true
            } catch {
                await out.send(
                    Event(event: "error", message: "Model load failed: \(error.localizedDescription)")
                )
                return false
            }
        }
        loadTask = task
        let ok = await task.value
        loadTask = nil
        return ok
    }

    func prewarm(model: String) async {
        guard !(await engine.isLoaded(model)) else {
            await out.send(Event(event: "prewarmed"))
            return
        }
        if await sharedLoad(model: model) {
            await out.send(Event(event: "prewarmed"))
        }
    }

    func unload() async {
        guard !recording else { return }
        if let task = loadTask {
            _ = await task.value
        }
        await engine.unload()
        await out.send(Event(event: "unloaded"))
    }

    func start(model: String, source: CaptureKind) async {
        guard !recording else {
            await out.send(Event(event: "error", message: "Already recording"))
            return
        }

        // Device-only capture never opens the mic — don't gate it on (or
        // prompt for) microphone permission.
        if source != .system {
            guard await engine.requestMicrophonePermission() else {
                await out.send(Event(event: "error", message: "Microphone permission denied"))
                return
            }
        }

        do {
            try await engine.startRecording(kind: source)
        } catch {
            await out.send(Event(event: "error", message: "Recording failed: \(error.localizedDescription)"))
            return
        }

        recording = true
        lastConfirmed = ""
        lastTail = ""
        lastDuration = 0
        await out.send(Event(event: "ready"))

        // Capture is live; load the model in parallel if it isn't resident.
        // `loading` after `ready` tells the HUD to show "warming up".
        if !(await engine.isLoaded(model)) {
            await out.send(Event(event: "loading"))
            Task { _ = await self.sharedLoad(model: model) }
        }

        // Cadence from the proven prototype: level 5 Hz; decode every 750 ms
        // once ≥12k new samples (~0.75 s at 16 kHz) have arrived.
        levelTask = Task {
            while !Task.isCancelled {
                await out.send(Event(event: "level", rms: engine.level()))
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
        transcribeTask = Task {
            while !Task.isCancelled {
                await self.transcribePass(minimumNewSamples: 12_000)
                try? await Task.sleep(for: .milliseconds(750))
            }
        }
    }

    private func transcribePass(minimumNewSamples: Int) async {
        do {
            if let update = try await engine.transcribeCurrentBuffer(minimumNewSamples: minimumNewSamples) {
                lastConfirmed = update.confirmedText
                lastTail = update.tailText
                lastDuration = update.durationSeconds
                await out.send(
                    Event(event: "partial", confirmed: update.confirmedText, tail: update.tailText)
                )
            }
        } catch is CancellationError {
            /* shutting down */
        } catch {
            await out.send(Event(event: "error", message: "Transcription failed: \(error.localizedDescription)"))
        }
    }

    func stop() async {
        guard recording else { return }
        recording = false
        levelTask?.cancel()
        transcribeTask?.cancel()
        levelTask = nil
        transcribeTask = nil
        await engine.stopRecording()

        // A short utterance can end before the model finishes loading — wait
        // for it, then flush; the whole buffered clip transcribes here.
        if let task = loadTask {
            _ = await task.value
        }

        // Flush whatever audio arrived after the last pass.
        await transcribePass(minimumNewSamples: 0)

        let text = [lastConfirmed, lastTail].filter { !$0.isEmpty }.joined(separator: " ")
        await out.send(Event(event: "final", text: text, duration_s: lastDuration))
        await engine.reset()
    }
}

@main
struct ChewoSTTWhisper {
    static func main() async {
        let out = Emitter()
        let controller = Controller(out: out)

        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                guard let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(Command.self, from: data)
                else { continue }

                switch command.cmd {
                case "start":
                    await controller.start(
                        model: command.model ?? "openai_whisper-base.en",
                        source: CaptureKind(rawValue: command.source ?? "mic") ?? .mic
                    )
                case "stop":
                    await controller.stop()
                case "prewarm":
                    await controller.prewarm(model: command.model ?? "openai_whisper-base.en")
                case "unload":
                    await controller.unload()
                case "shutdown":
                    await controller.stop()
                    exit(0)
                default:
                    await out.send(Event(event: "error", message: "Unknown command: \(command.cmd)"))
                }
            }
        } catch {
            /* stdin read failed — treat as parent gone */
        }

        // stdin closed: parent exited — stop cleanly and go down with it.
        await controller.stop()
    }
}
