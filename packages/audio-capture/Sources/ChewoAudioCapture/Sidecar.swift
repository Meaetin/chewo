import Foundation

/// Headless audio-capture sidecar for Chewo (SPEC-NOTES.md §6, SPEC-TODOS.md
/// §6): control over stdio as JSON lines, PCM over fd 3.
///
/// stdin:  {"cmd":"start","source":"mic"}
///           source: "mic" (default, dictation) | "mix" (device output + mic)
///           | "system" (device output only) — mix/system need macOS 14.2+
///           and the System Audio Recording permission
///         {"cmd":"stop"}   {"cmd":"shutdown"}
/// stdout: {"event":"ready"} {"event":"level","rms":0.3}
///         {"event":"stopped"} {"event":"error","message":"…"}
/// fd 3:   raw 16 kHz mono interleaved Int16 (Deepgram `linear16`), in ~50 ms
///         frames, from `ready` until `stopped`.
///
/// This process knows nothing about transcription. It exists because nothing
/// in Electron can open a Core Audio process tap, which is what `mix` and
/// `system` are — the Deepgram connection, the API key, and every decision
/// about what the words mean live in the main process.
///
/// `stopped` is emitted only after the sink has drained, so a reader that
/// has consumed fd 3 up to that point has the complete recording.

struct Command: Decodable {
    let cmd: String
    let source: String?
}

struct Event: Encodable, Sendable {
    var event: String
    var rms: Double? = nil
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
    private let out: Emitter
    private let sink: FrameSink
    private var capture: CaptureSource?
    private var levelTask: Task<Void, Never>?
    private var recording = false
    /// True from the moment `start` is accepted until capture is live — a
    /// stop arriving in that window must not be dropped.
    private var starting = false
    private var stopRequested = false

    init(out: Emitter, sink: FrameSink) {
        self.out = out
        self.sink = sink
    }

    func start(source: CaptureKind) async {
        guard !recording else {
            await out.send(Event(event: "error", message: "Already recording"))
            return
        }
        starting = true
        defer { starting = false }

        // Device-only capture never opens the mic — don't gate it on (or
        // prompt for) microphone permission.
        if source != .system {
            guard await requestMicrophonePermission() else {
                await out.send(Event(event: "error", message: "Microphone permission denied"))
                return
            }
        }

        let capture: CaptureSource
        do {
            capture = try makeCapture(source, sink: sink)
            try capture.start()
        } catch {
            await out.send(
                Event(event: "error", message: "Recording failed: \(error.localizedDescription)")
            )
            return
        }
        self.capture = capture

        // A stop that landed during the permission prompt applies to this
        // capture: honour it rather than recording on after the user gave up.
        if stopRequested {
            stopRequested = false
            capture.stop()
            self.capture = nil
            sink.drain()
            await out.send(Event(event: "stopped"))
            return
        }

        recording = true
        await out.send(Event(event: "ready"))

        levelTask = Task { [out, capture] in
            while !Task.isCancelled {
                await out.send(Event(event: "level", rms: capture.level()))
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
    }

    func stop() async {
        guard recording else {
            // Stop is the user's escape hatch, so it always resolves the
            // session: mid-`start` it cancels that capture, and otherwise it
            // emits the terminal event the UI is waiting on rather than
            // leaving it stuck on "Connecting…" forever.
            if starting {
                stopRequested = true
            } else {
                await out.send(Event(event: "stopped"))
            }
            return
        }
        recording = false
        levelTask?.cancel()
        levelTask = nil
        capture?.stop()
        capture = nil
        // The trailing frames are on the sink queue; `stopped` must not
        // overtake them or the reader would cut the recording short.
        sink.drain()
        await out.send(Event(event: "stopped"))
    }
}

@main
struct ChewoAudioCapture {
    /// PCM goes out of band on fd 3 so stdout stays a clean JSON-lines
    /// channel — the parent spawns us with a fourth pipe.
    static let audioFD: Int32 = 3

    static func main() async {
        let out = Emitter()
        let sink = FrameSink(fd: audioFD) { message in
            // Actor-isolated send from a plain callback; the capture threads
            // never await, so this is the one place a hop is needed.
            Task { await out.send(Event(event: "error", message: message)) }
        }
        let controller = Controller(out: out, sink: sink)

        if fcntl(audioFD, F_GETFD) == -1 {
            await out.send(
                Event(event: "error", message: "No audio pipe on fd 3 — spawn with a fourth stdio pipe")
            )
        }

        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                guard let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(Command.self, from: data)
                else { continue }

                // Only start/stop are awaited here, and only so their order is
                // preserved. Anything that could block belongs off this loop:
                // when the sidecar stops *reading its stdin*, a `start` typed
                // during the block sits unread in the pipe and the following
                // `stop` with it — the app hangs with a dead Stop button.
                switch command.cmd {
                case "start":
                    await controller.start(
                        source: CaptureKind(rawValue: command.source ?? "mic") ?? .mic
                    )
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
