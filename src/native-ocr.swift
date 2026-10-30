// Local diagnostic OCR only. Screen captures are never product image assets.
import Foundation
import Vision
import ImageIO
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
let rows = (request.results ?? []).compactMap { observation -> [String: Any]? in
    guard let text = observation.topCandidates(1).first else { return nil }
    let b = observation.boundingBox
    return ["text": text.string, "confidence": text.confidence, "x": b.minX, "y": 1-b.maxY, "width": b.width, "height": b.height]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: rows))
