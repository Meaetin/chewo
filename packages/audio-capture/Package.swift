// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "chewo-audio-capture",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "chewo-audio-capture",
            targets: ["ChewoAudioCapture"]
        )
    ],
    targets: [
        .executableTarget(
            name: "ChewoAudioCapture",
            linkerSettings: [
                // Bare CLIs have no bundle, so the mic / system-audio TCC
                // usage strings are embedded in the executable itself
                // (__TEXT,__info_plist — the standard trick for CLI tools).
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Resources/Info.plist"
                ])
            ]
        )
    ]
)
