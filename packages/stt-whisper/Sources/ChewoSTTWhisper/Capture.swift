// @preconcurrency: AVAudioConverter's input block is @Sendable but runs
// synchronously inside convert(); AVAudioPCMBuffer isn't Sendable-annotated.
@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import WhisperKit

/// Which audio the engine captures. Raw values are the sidecar protocol's
/// `source` field (SPEC-NOTES §6): `mic` is dictation, `mix` is device
/// output + mic summed into one stream — online lessons and meetings —
/// and `system` is device output alone (the user isn't transcribed).
enum CaptureKind: String {
    case mic
    case mix
    case system
}

/// Rolling 16 kHz mono buffer shared by every capture implementation.
///
/// Capture threads append; the engine snapshots and, once segments are
/// confirmed, drops the audio behind them — so resident audio is bounded by
/// the unconfirmed tail, not the session length. Positions are *absolute*
/// sample indices since capture start, which survive drops (`startSample`
/// says where the current window begins).
final class SampleBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Float] = []
    private var dropped = 0

    func append(_ chunk: [Float]) {
        lock.lock()
        samples.append(contentsOf: chunk)
        lock.unlock()
    }

    /// Current window plus the absolute index of its first sample.
    func snapshot() -> (samples: [Float], startSample: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (samples, dropped)
    }

    /// Total samples ever captured (dropped + resident).
    func absoluteCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return dropped + samples.count
    }

    /// Discards audio before the absolute sample index. Exact under
    /// concurrent appends — new audio only ever lands at the tail.
    func drop(through absoluteSample: Int) {
        lock.lock()
        let n = min(max(0, absoluteSample - dropped), samples.count)
        if n > 0 {
            samples.removeFirst(n)
            dropped += n
        }
        lock.unlock()
    }

    func reset() {
        lock.lock()
        samples.removeAll()
        dropped = 0
        lock.unlock()
    }
}

/// A capture implementation: opens its audio source, streams 16 kHz mono
/// Float32 into `buffer`, and reports a 0…1 level for the meter.
protocol CaptureSource: AnyObject, Sendable {
    var buffer: SampleBuffer { get }
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
        }
    }
}

// MARK: - Mic

/// Dictation capture: WhisperKit's `AudioProcessor` mic pipeline, which
/// already converts to 16 kHz mono. The per-buffer callback forwards into
/// the rolling buffer and prunes the processor's internal accumulator from
/// the same thread that appends to it — so it can't race, and neither
/// buffer grows with session length.
final class MicCapture: CaptureSource, @unchecked Sendable {
    let buffer = SampleBuffer()
    private let audioProcessor = AudioProcessor()

    func start() throws {
        let buffer = self.buffer
        let processor = audioProcessor
        try audioProcessor.startRecordingLive(inputDeviceID: nil) { chunk in
            buffer.append(chunk)
            processor.purgeAudioSamples(keepingLast: WhisperKit.sampleRate)
        }
    }

    func stop() {
        audioProcessor.stopRecording()
    }

    func level() -> Double {
        Double(audioProcessor.relativeEnergy.last ?? 0)
    }
}

// MARK: - Device output + mic

/// Meeting/online-lesson capture (macOS 14.2+): a Core Audio process tap
/// over all system output, optionally plus the default mic, combined in one
/// private aggregate device with drift compensation — the HAL reconciles the
/// two clocks, so a single IOProc receives both already in sync. Channels
/// are summed to mono and resampled to 16 kHz through one stateful
/// converter. `includeMic: false` is device-only capture (`system`).
///
/// The first `AudioHardwareCreateProcessTap` triggers the one-time
/// System Audio Recording permission prompt (its usage string is embedded
/// in the executable's __info_plist section — see Package.swift).
@available(macOS 14.2, *)
final class DeviceMixCapture: CaptureSource, @unchecked Sendable {
    let buffer = SampleBuffer()

    private let includeMic: Bool
    private let queue = DispatchQueue(label: "chewo.stt.devicemix")

    init(includeMic: Bool) {
        self.includeMic = includeMic
    }
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?

    private let levelLock = NSLock()
    private var lastRelativeEnergy: Double = 0
    private var chunkEnergies: [Float] = []

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
        let inputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: deviceRate, channels: 1, interleaved: false
        )
        let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(WhisperKit.sampleRate),
            channels: 1,
            interleaved: false
        )
        if let inputFormat, let outputFormat, deviceRate != Double(WhisperKit.sampleRate) {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        }

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
    }

    func level() -> Double {
        levelLock.lock()
        defer { levelLock.unlock() }
        return lastRelativeEnergy
    }

    // MARK: internals

    /// Sums every input channel (mic + tap, already drift-aligned by the
    /// aggregate) into mono, resamples to 16 kHz, appends to the buffer.
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

        updateLevel(with: mono)

        if let converter {
            buffer.append(resample(mono, with: converter, deviceRate: deviceRate))
        } else {
            buffer.append(mono)
        }
    }

    /// One stateful converter across the whole session so chunk boundaries
    /// don't click; `.noDataNow` (not `.endOfStream`) keeps it primed for
    /// the next callback.
    private func resample(_ mono: [Float], with converter: AVAudioConverter, deviceRate: Double) -> [Float] {
        guard
            let inBuffer = AVAudioPCMBuffer(
                pcmFormat: converter.inputFormat, frameCapacity: AVAudioFrameCount(mono.count)
            ),
            let channel = inBuffer.floatChannelData
        else { return [] }
        mono.withUnsafeBufferPointer { source in
            channel[0].update(from: source.baseAddress!, count: mono.count)
        }
        inBuffer.frameLength = AVAudioFrameCount(mono.count)

        let ratio = Double(WhisperKit.sampleRate) / deviceRate
        let capacity = AVAudioFrameCount(Double(mono.count) * ratio) + 64
        guard
            let outBuffer = AVAudioPCMBuffer(
                pcmFormat: converter.outputFormat, frameCapacity: capacity
            )
        else { return [] }

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
        guard conversionError == nil, let out = outBuffer.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: out[0], count: Int(outBuffer.frameLength)))
    }

    /// Same scheme as WhisperKit's mic meter: energy of this chunk relative
    /// to the quietest of the last ~2 s of chunks.
    private func updateLevel(with chunk: [Float]) {
        let energy = AudioProcessor.calculateEnergy(of: chunk).avg
        levelLock.lock()
        chunkEnergies.append(energy)
        if chunkEnergies.count > 20 { chunkEnergies.removeFirst(chunkEnergies.count - 20) }
        let minEnergy = chunkEnergies.min()
        levelLock.unlock()
        let relative = AudioProcessor.calculateRelativeEnergy(of: chunk, relativeTo: minEnergy)
        levelLock.lock()
        lastRelativeEnergy = Double(relative)
        levelLock.unlock()
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

func makeCapture(_ kind: CaptureKind) throws -> CaptureSource {
    switch kind {
    case .mic:
        return MicCapture()
    case .mix, .system:
        guard #available(macOS 14.2, *) else { throw CaptureError.unsupportedOS }
        return DeviceMixCapture(includeMic: kind == .mix)
    }
}
