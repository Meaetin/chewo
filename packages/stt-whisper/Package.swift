// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "chewo-stt-whisper",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "chewo-stt-whisper",
            targets: ["ChewoSTTWhisper"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", branch: "main")
    ],
    targets: [
        .executableTarget(
            name: "ChewoSTTWhisper",
            dependencies: [
                .product(name: "WhisperKit", package: "argmax-oss-swift")
            ],
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
