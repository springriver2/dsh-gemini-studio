import AVFoundation
import Foundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
guard let video = try await asset.loadTracks(withMediaType: .video).first else {
    throw CocoaError(.fileReadCorruptFile)
}
let duration = try await asset.load(.duration).seconds
let size = try await video.load(.naturalSize)
let transform = try await video.load(.preferredTransform)
let displaySize = size.applying(transform)
let audio = try await asset.loadTracks(withMediaType: .audio)
let result: [String: Any] = [
    "duration": duration,
    "width": Int(abs(displaySize.width).rounded()),
    "height": Int(abs(displaySize.height).rounded()),
    "audioTracks": audio.count,
]
let data = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
