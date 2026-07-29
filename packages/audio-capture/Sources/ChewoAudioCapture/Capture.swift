// @preconcurrency: AVAudioConverter's input block is @Sendable but runs
// synchronously inside convert(); AVAudioPCMBuffer isn't Sendable-annotated.
@preconcurrency import AVFoundation
import Accelerate
import CoreAudio
import Foundation

/// Everything downstream of this file speaks one format: 16 kHz mono
/// interleaved Int16 — Deepgram's `linear16`, put straight onto the wire by
/// the Electron main process with no re-encoding.
let captureSampleRate = 16_000

/// ~50 ms per frame (800 samples, 1600 bytes). Deepgram wants chunks in the
/// 20–250 ms band; the raw callback sizes sit below it (a Core Audio IOProc
/// delivers ~10 ms), so frames are accumulated to this before a write.
private let frameBytes = 1_600

/// Which audio the sidecar captures. Raw values are the protocol's `source`
/// field (SPEC-NOTES §6): `mic` is dictation, `mix` is device output + mic
/// summed into one stream — online lessons and meetings — and `system` is
/// device output alone (the user isn't transcribed).
enum CaptureKind: String {
    case mic
    case mix
    case system
}

/// Buffers PCM into ~50 ms frames and writes them to the audio fd on a
/// dedicated queue.
///
/// The write never happens on the thread that produced the audio: a Core
/// Audio IOProc is a realtime context, and a `write` into a full pipe blocks
/// until the reader drains it — which would surface as dropouts in the
/// recording rather than as backpressure anywhere visible.
final class FrameSink: @unchecked Sendable {
    private let fd: Int32
    private let queue = DispatchQueue(label: "chewo.capture.sink")
    private let lock = NSLock()
    private var pending = Data()
    private var failed = false

    /// Called once if the fd turns out to be unusable — a hand-driven sidecar
    /// with no fd 3 attached would otherwise capture happily into nothing.
    private let onFailure: @Sendable (String) -> Void

    init(fd: Int32, onFailure: @escaping @Sendable (String) -> Void) {
        self.fd = fd
        self.onFailure = onFailure
    }

    func append(_ chunk: Data) {
        lock.lock()
        pending.append(chunk)
        var frames: [Data] = []
        while pending.count >= frameBytes {
            frames.append(pending.prefix(frameBytes))
            pending.removeFirst(frameBytes)
        }
        lock.unlock()
        for frame in frames { enqueue(frame) }
    }

    /// Pushes the partial frame left at the end of a capture — the last
    /// fraction of a second of speech lives here.
    func flush() {
        lock.lock()
        let rest = pending
        pending.removeAll()
        lock.unlock()
        if !rest.isEmpty { enqueue(rest) }
    }

    func reset() {
        lock.lock()
        pending.removeAll()
        failed = false
        lock.unlock()
    }

    /// Blocks until every queued frame has reached the fd. The queue is
    /// serial, so an empty sync block is a barrier behind all prior writes —
    /// this is what lets `stopped` be emitted only after the last audio byte.
    func drain() {
        queue.sync {}
    }

    private func enqueue(_ frame: Data) {
        queue.async { [self] in
            guard !failed else { return }
            frame.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                var offset = 0
                while offset < raw.count {
                    let written = write(fd, base + offset, raw.count - offset)
                    if written > 0 {
                        offset += written
                        continue
                    }
                    // EINTR is a signal landing mid-write, not a broken pipe.
                    if written < 0 && errno == EINTR { continue }
                    failed = true
                    onFailure("Audio pipe write failed (errno \(errno))")
                    return
                }
            }
        }
    }
}

/// Chunk energy in dB relative to the quietest of the last ~2 s of chunks,
/// clamped to 0…1 — the meter shape the WhisperKit mic pipeline produced,
/// reimplemented so nothing here depends on WhisperKit.
final class LevelMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var recentEnergies: [Float] = []
    private var lastRelative: Double = 0

    func update(with chunk: [Float]) {
        guard !chunk.isEmpty else { return }
        var energy: Float = 0
        vDSP_rmsqv(chunk, 1, &energy, vDSP_Length(chunk.count))
        energy = max(1e-8, energy)

        lock.lock()
        recentEnergies.append(energy)
        if recentEnergies.count > 20 { recentEnergies.removeFirst(recentEnergies.count - 20) }
        // 1e-3 is the reference floor for a window that hasn't filled yet —
        // without it the first chunk is always its own minimum, i.e. silent.
        let reference = max(1e-8, recentEnergies.min() ?? 1e-3)
        lock.unlock()

        let db = 20 * log10(energy)
        let referenceDb = 20 * log10(reference)
        // A reference at or above full scale leaves no range to rescale into.
        let relative = referenceDb < 0 ? Double((db - referenceDb) / (0 - referenceDb)) : 0

        lock.lock()
        lastRelative = max(0, min(1, relative))
        lock.unlock()
    }

    func level() -> Double {
        lock.lock()
        defer { lock.unlock() }
        return lastRelative
    }
}

/// A capture implementation: opens its audio source, streams 16 kHz mono
/// Int16 into the sink, and reports a 0…1 level for the meter.
protocol CaptureSource: AnyObject, Sendable {
    func start() throws
    func stop()
    func level() -> Double
}

enum CaptureError: LocalizedError {
    case tapCreation(OSStatus)
    case aggregateCreation(OSStatus)
    case ioProc(OSStatus)
    case deviceStart(OSStatus)
    case noInputDevice
    case unsupportedOS
    case converterSetup
    case engineStart(String)

    var errorDescription: String? {
        switch self {
        case let .tapCreation(status):
            return "System audio tap failed (status \(status)) — check System Settings › Privacy & Security › Screen & System Audio Recording"
        case let .aggregateCreation(status):
            return "Audio device setup failed (status \(status))"
        case let .ioProc(status):
            return "Audio IO setup failed (status \(status))"
        case let .deviceStart(status):
            return "Audio device start failed (status \(status))"
        case .noInputDevice:
            return "No microphone input device found"
        case .unsupportedOS:
            return "System audio capture requires macOS 14.2 or later"
        case .converterSetup:
            return "Could not build the 16 kHz mono converter for this device"
        case let .engineStart(message):
            return "Microphone start failed: \(message)"
        }
    }
}

// MARK: - Mic

/// Dictation capture: `AVAudioEngine`'s input node tapped directly, with one
/// `AVAudioConverter` to 16 kHz mono Int16 — the same target format the mix
/// path converts to, so both sources reach Deepgram identically.
///
/// The converter also does the channel downmix, so a stereo interface or a
/// multi-channel aggregate input needs no special case here.
final class MicCapture: CaptureSource, @unchecked Sendable {
    private let sink: FrameSink
    private let meter = LevelMeter()
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?

    init(sink: FrameSink) {
        self.sink = sink
    }

    func start() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard
            inputFormat.sampleRate > 0,
            let target = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: Double(captureSampleRate),
                channels: 1,
                interleaved: true
            ),
            let converter = AVAudioConverter(from: inputFormat, to: target)
        else { throw CaptureError.converterSetup }

        self.converter = converter
        outputFormat = target

        // ~85 ms at 48 kHz. A hint rather than a contract — the sink reframes
        // whatever arrives to 50 ms before it reaches the pipe.
        input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw CaptureError.engineStart(error.localizedDescription)
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        sink.flush()
        converter = nil
    }

    func level() -> Double {
        meter.level()
    }

    private func handle(_ buffer: AVAudioPCMBuffer) {
        guard let converter, let outputFormat else { return }

        meter.update(with: monoFloats(of: buffer))

        let ratio = Double(captureSampleRate) / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity)
        else { return }

        // Single-element box: the input block runs synchronously inside
        // convert(), the Sendable checker just can't see that.
        final class Once: @unchecked Sendable { var consumed = false }
        let once = Once()
        var conversionError: NSError?
        converter.convert(to: out, error: &conversionError) { _, outStatus in
            if once.consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            once.consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard conversionError == nil, let channel = out.int16ChannelData, out.frameLength > 0
        else { return }

        sink.append(
            Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
        )
    }

    /// Meter input only — the converter does the real downmix.
    private func monoFloats(of buffer: AVAudioPCMBuffer) -> [Float] {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return [] }
        let frames = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        var mono = [Float](repeating: 0, count: frames)
        for channel in 0..<channelCount {
            vDSP_vadd(mono, 1, channels[channel], 1, &mono, 1, vDSP_Length(frames))
        }
        if channelCount > 1 {
            var divisor = Float(channelCount)
            vDSP_vsdiv(mono, 1, &divisor, &mono, 1, vDSP_Length(frames))
        }
        return mono
    }
}

// MARK: - Device output + mic

/// Meeting/online-lesson capture (macOS 14.2+): a Core Audio process tap
/// over all system output, optionally plus the default mic, combined in one
/// private aggregate device with drift compensation — the HAL reconciles the
/// two clocks, so a single IOProc receives both already in sync. Channels
/// are summed to mono and resampled to 16 kHz Int16 through one stateful
/// converter. `includeMic: false` is device-only capture (`system`).
///
/// The first `AudioHardwareCreateProcessTap` triggers the one-time
/// System Audio Recording permission prompt (its usage string is embedded
/// in the executable's __info_plist section — see Package.swift).
@available(macOS 14.2, *)
final class DeviceMixCapture: CaptureSource, @unchecked Sendable {
    private let sink: FrameSink
    private let meter = LevelMeter()
    private let includeMic: Bool
    private let queue = DispatchQueue(label: "chewo.capture.devicemix")

    init(includeMic: Bool, sink: FrameSink) {
        self.includeMic = includeMic
        self.sink = sink
    }
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?

    func start() throws {
        // Global mono mixdown of everything the system plays. Nothing is
        // excluded: Chewo itself produces no audio, and muting behavior
        // stays default so the user keeps hearing their meeting.
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { throw CaptureError.tapCreation(status) }

        let subDevices: [[String: Any]]
        if includeMic, let micUID = Self.defaultInputDeviceUID() {
            subDevices = [[
                kAudioSubDeviceUIDKey: micUID,
                kAudioSubDeviceDriftCompensationKey: 1
            ]]
        } else {
            // Device-only capture, or no mic present (record the device
            // side rather than fail).
            subDevices = []
        }

        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Chewo Meeting Capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: 1,
            kAudioAggregateDeviceSubDeviceListKey: subDevices,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: 1
            ]],
            kAudioAggregateDeviceTapAutoStartKey: 1
        ]

        status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
        guard status == noErr else {
            cleanup()
            throw CaptureError.aggregateCreation(status)
        }

        let deviceRate = Self.nominalSampleRate(of: aggregateID) ?? 48_000
        // Unlike the old Float32 path there is no rate-match shortcut: even at
        // 16 kHz the converter still has the Float32 → Int16 job to do.
        guard
            let inputFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: deviceRate, channels: 1, interleaved: false
            ),
            let target = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: Double(captureSampleRate),
                channels: 1,
                interleaved: true
            ),
            let converter = AVAudioConverter(from: inputFormat, to: target)
        else {
            cleanup()
            throw CaptureError.converterSetup
        }
        self.converter = converter
        outputFormat = target

        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue) {
            [weak self] _, inputData, _, _, _ in
            self?.handle(inputData: inputData, deviceRate: deviceRate)
        }
        guard status == noErr, let ioProcID else {
            cleanup()
            throw CaptureError.ioProc(status)
        }

        status = AudioDeviceStart(aggregateID, ioProcID)
        guard status == noErr else {
            cleanup()
            throw CaptureError.deviceStart(status)
        }
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown, let ioProcID {
            AudioDeviceStop(aggregateID, ioProcID)
        }
        cleanup()
        sink.flush()
    }

    func level() -> Double {
        meter.level()
    }

    // MARK: internals

    /// Sums every input channel (mic + tap, already drift-aligned by the
    /// aggregate) into mono, resamples to 16 kHz Int16, hands it to the sink.
    /// Runs on the IO queue only.
    private func handle(inputData: UnsafePointer<AudioBufferList>, deviceRate: Double) {
        let bufferList = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: inputData)
        )

        var frameCount = 0
        for audioBuffer in bufferList where audioBuffer.mNumberChannels > 0 {
            let frames = Int(audioBuffer.mDataByteSize) / (MemoryLayout<Float>.size * Int(audioBuffer.mNumberChannels))
            frameCount = max(frameCount, frames)
        }
        guard frameCount > 0 else { return }

        var mono = [Float](repeating: 0, count: frameCount)
        for audioBuffer in bufferList {
            let channels = Int(audioBuffer.mNumberChannels)
            guard channels > 0, let data = audioBuffer.mData else { continue }
            let floats = data.assumingMemoryBound(to: Float.self)
            let frames = Int(audioBuffer.mDataByteSize) / (MemoryLayout<Float>.size * channels)
            for frame in 0..<min(frames, frameCount) {
                var sum: Float = 0
                for channel in 0..<channels {
                    sum += floats[frame * channels + channel]
                }
                mono[frame] += sum
            }
        }

        meter.update(with: mono)
        if let frame = convert(mono, deviceRate: deviceRate) { sink.append(frame) }
    }

    /// One stateful converter across the whole session so chunk boundaries
    /// don't click; `.noDataNow` (not `.endOfStream`) keeps it primed for
    /// the next callback.
    private func convert(_ mono: [Float], deviceRate: Double) -> Data? {
        guard let converter, let outputFormat else { return nil }
        guard
            let inBuffer = AVAudioPCMBuffer(
                pcmFormat: converter.inputFormat, frameCapacity: AVAudioFrameCount(mono.count)
            ),
            let channel = inBuffer.floatChannelData
        else { return nil }
        mono.withUnsafeBufferPointer { source in
            channel[0].update(from: source.baseAddress!, count: mono.count)
        }
        inBuffer.frameLength = AVAudioFrameCount(mono.count)

        let ratio = Double(captureSampleRate) / deviceRate
        let capacity = AVAudioFrameCount(Double(mono.count) * ratio) + 64
        guard
            let outBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity)
        else { return nil }

        // Single-element box: the input block runs synchronously inside
        // convert(), the Sendable checker just can't see that.
        final class Once: @unchecked Sendable { var consumed = false }
        let once = Once()
        var conversionError: NSError?
        converter.convert(to: outBuffer, error: &conversionError) { _, outStatus in
            if once.consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            once.consumed = true
            outStatus.pointee = .haveData
            return inBuffer
        }
        guard conversionError == nil, let out = outBuffer.int16ChannelData, outBuffer.frameLength > 0
        else { return nil }
        return Data(bytes: out[0], count: Int(outBuffer.frameLength) * MemoryLayout<Int16>.size)
    }

    private func cleanup() {
        if aggregateID != kAudioObjectUnknown, let ioProcID {
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
        }
        ioProcID = nil
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
        converter = nil
    }

    private static func defaultInputDeviceUID() -> String? {
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID
            ) == noErr,
            deviceID != kAudioObjectUnknown
        else { return nil }

        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        address.mSelector = kAudioDevicePropertyDeviceUID
        guard
            AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid) == noErr,
            let uid
        else { return nil }
        return uid.takeRetainedValue() as String
    }

    private static func nominalSampleRate(of deviceID: AudioObjectID) -> Double? {
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard
            AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &rate) == noErr,
            rate > 0
        else { return nil }
        return rate
    }
}

func makeCapture(_ kind: CaptureKind, sink: FrameSink) throws -> CaptureSource {
    switch kind {
    case .mic:
        return MicCapture(sink: sink)
    case .mix, .system:
        guard #available(macOS 14.2, *) else { throw CaptureError.unsupportedOS }
        return DeviceMixCapture(includeMic: kind == .mix, sink: sink)
    }
}

/// macOS gates the mic through TCC's capture-device authorization, not
/// `AVAudioApplication` (which is iOS-only) — asking here rather than letting
/// `engine.start()` prompt implicitly means a denial becomes a clean error
/// event instead of a capture that silently records digital black.
func requestMicrophonePermission() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .notDetermined:
        return await AVCaptureDevice.requestAccess(for: .audio)
    default:
        return false
    }
}
