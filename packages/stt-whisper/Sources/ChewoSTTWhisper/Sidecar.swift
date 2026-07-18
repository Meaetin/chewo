import Foundation

/// Headless STT sidecar for Chewo (SPEC-NOTES.md §6): JSON-lines over stdio.
///
/// stdin:  {"cmd":"start","model":"openai_whisper-large-v3-v20240930_turbo"}
///         {"cmd":"stop"}   {"cmd":"shutdown"}
/// stdout: {"event":"loading"} {"event":"ready"} {"event":"level","rms":0.3}
///         {"event":"partial","confirmed":"…","tail":"…"}
///         {"event":"final","text":"…","duration_s":12.4}
///         {"event":"error","message":"…"}

struct Command: Decodable {
    let cmd: String
    let model: String?
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
    private var recording = false
    private var lastConfirmed = ""
    private var lastTail = ""
    private var lastDuration: Double = 0

    init(out: Emitter) {
        self.out = out
    }

    func start(model: String) async {
        guard !recording else {
            await out.send(Event(event: "error", message: "Already recording"))
            return
        }

        await out.send(Event(event: "loading"))
        do {
            try await engine.load(modelName: model)
        } catch {
            await out.send(Event(event: "error", message: "Model load failed: \(error.localizedDescription)"))
            return
        }

        guard await engine.requestMicrophonePermission() else {
            await out.send(Event(event: "error", message: "Microphone permission denied"))
            return
        }

        do {
            try await engine.startRecording()
        } catch {
            await out.send(Event(event: "error", message: "Recording failed: \(error.localizedDescription)"))
            return
        }

        recording = true
        lastConfirmed = ""
        lastTail = ""
        lastDuration = 0
        await out.send(Event(event: "ready"))

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
                    await controller.start(model: command.model ?? "openai_whisper-base.en")
                case "stop":
                    await controller.stop()
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
