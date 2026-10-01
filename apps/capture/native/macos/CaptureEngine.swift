// kortix-capture-engine: native macOS sidecar for the capture recorder.
//
// Protocol: one JSON request per stdin line, one JSON response per stdout line.
// Every response carries `ok`; failures carry `error`. The Rust side
// (src/memory/engine.rs) owns policy, storage, and scheduling; this process
// only touches Apple frameworks (ScreenCaptureKit, Vision, AX, AVFoundation).
//
// Commands: ping, permissions, request_permissions, capture, ocr, icon,
// encode, extract.

import AVFoundation
import AppKit
import ApplicationServices
import CoreImage
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

// MARK: - JSON plumbing

typealias JSON = [String: Any]

func emit(_ obj: JSON) {
    var obj = obj
    if obj["ok"] == nil { obj["ok"] = true }
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
        FileHandle.standardOutput.write("{\"ok\":false,\"error\":\"encode_failed\"}\n".data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> JSON { ["ok": false, "error": message] }

func blocking<T>(_ body: @escaping () async throws -> T) throws -> T {
    let sema = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    Task.detached {
        do { result = .success(try await body()) } catch { result = .failure(error) }
        sema.signal()
    }
    sema.wait()
    return try result.get()
}

// MARK: - Accessibility helpers

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = axAttr(el, name) else { return nil }
    if let s = v as? String { return s }
    if CFGetTypeID(v) == CFURLGetTypeID() { return (v as! URL).absoluteString }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axAttr(el, kAXPositionAttribute), let s = axAttr(el, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return CGRect(origin: point, size: size)
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// Breadth-first search for the first AXWebArea carrying an AXURL.
func findWebURL(_ root: AXUIElement, budget: Int = 2500) -> String? {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < budget {
        let el = queue.removeFirst()
        visited += 1
        if axString(el, kAXRoleAttribute) == "AXWebArea", let url = axString(el, "AXURL"), !url.isEmpty {
            return url
        }
        queue.append(contentsOf: axChildren(el))
    }
    return nil
}

/// Role descriptions macOS derives from the role alone carry no information.
func defaultRoleDescription(_ role: String?) -> String? {
    guard let role else { return nil }
    return NSAccessibility.Role(rawValue: role).description(with: nil)
}

func axTree(_ el: AXUIElement, depth: Int, maxDepth: Int, budget: inout Int) -> JSON? {
    guard budget > 0 else { return nil }
    budget -= 1
    var node: JSON = ["role": axString(el, kAXRoleAttribute) ?? "AXUnknown"]
    if let v = axString(el, kAXTitleAttribute), !v.isEmpty { node["title"] = v }
    if let v = axString(el, kAXDescriptionAttribute), !v.isEmpty { node["description"] = v }
    if let v = axString(el, kAXValueAttribute), !v.isEmpty { node["value"] = String(v.prefix(4000)) }
    if let v = axString(el, "AXURL"), !v.isEmpty { node["url"] = v }
    // Extra attributes that identify web elements and roles.
    if let v = axString(el, kAXSubroleAttribute), !v.isEmpty { node["subrole"] = v }
    if let v = axString(el, kAXRoleDescriptionAttribute), !v.isEmpty, v != defaultRoleDescription(node["role"] as? String) { node["role_description"] = v }
    if let v = axString(el, "AXDOMIdentifier"), !v.isEmpty { node["dom_id"] = v }
    if let v = axAttr(el, "AXDOMClassList") as? [String], !v.isEmpty { node["dom_class"] = v.joined(separator: " ") }
    if let v = axAttr(el, "AXVisited") as? Bool, v { node["visited"] = true }
    if let f = axFrame(el) {
        node["x"] = Int(f.origin.x); node["y"] = Int(f.origin.y)
        node["w"] = Int(f.size.width); node["h"] = Int(f.size.height)
    }
    if let hidden = axAttr(el, "AXHidden") as? Bool, hidden { node["hidden"] = true }
    if let enabled = axAttr(el, kAXEnabledAttribute) as? Bool, !enabled { node["disabled"] = true }
    if depth < maxDepth {
        var kids: [JSON] = []
        for child in axChildren(el) {
            guard let k = axTree(child, depth: depth + 1, maxDepth: maxDepth, budget: &budget) else { break }
            kids.append(k)
        }
        if !kids.isEmpty { node["children"] = kids }
    } else if !axChildren(el).isEmpty {
        node["truncated"] = true
    }
    return node
}

// MARK: - Session / idle / app metadata

func screenLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let locked = dict["CGSSessionScreenIsLocked"] as? Bool, locked { return true }
    if let onConsole = dict[kCGSessionOnConsoleKey as String] as? Bool, !onConsole { return true }
    return false
}

func idleSeconds() -> Double {
    CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
}

func appVersion(_ app: NSRunningApplication) -> String {
    guard let url = app.bundleURL, let bundle = Bundle(url: url) else { return "" }
    return (bundle.infoDictionary?["CFBundleShortVersionString"] as? String) ?? ""
}

let privateMarkers = ["private browsing", "incognito", "— private", "- private", "(private)", "inprivate"]

func looksPrivate(title: String?) -> Bool {
    guard let t = title?.lowercased() else { return false }
    return privateMarkers.contains { t.contains($0) }
}

func hostOf(_ url: String?) -> String? {
    guard let url, let comps = URLComponents(string: url), let host = comps.host?.lowercased(), !host.isEmpty else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}

func domainMatches(_ host: String, _ patterns: [String]) -> Bool {
    patterns.contains { p in
        let p = p.lowercased().trimmingCharacters(in: .whitespaces)
        return !p.isEmpty && (host == p || host.hasSuffix("." + p))
    }
}

// MARK: - Image helpers

func writeJPEG(_ image: CGImage, to path: String, quality: Double) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw NSError(domain: "engine", code: 1, userInfo: [NSLocalizedDescriptionKey: "jpeg_dest"])
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
        throw NSError(domain: "engine", code: 2, userInfo: [NSLocalizedDescriptionKey: "jpeg_write"])
    }
}

func writePNG(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "engine", code: 1, userInfo: [NSLocalizedDescriptionKey: "png_dest"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else {
        throw NSError(domain: "engine", code: 2, userInfo: [NSLocalizedDescriptionKey: "png_write"])
    }
}

func loadImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// 64-bit difference hash over a 9x8 grayscale thumbnail, hex encoded.
func dhash(_ image: CGImage) -> String {
    let w = 9, h = 8
    var pixels = [UInt8](repeating: 0, count: w * h)
    let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    var bits: UInt64 = 0
    for y in 0..<h { for x in 0..<(w - 1) {
        bits <<= 1
        if pixels[y * w + x] > pixels[y * w + x + 1] { bits |= 1 }
    } }
    return String(format: "%016llx", bits)
}

func dominantColor(_ image: CGImage) -> Int {
    var px = [UInt8](repeating: 0, count: 4)
    let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    return (Int(px[0]) << 16) | (Int(px[1]) << 8) | Int(px[2])
}

// MARK: - Commands

func permissions() -> JSON {
    ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
}

func requestPermissions() -> JSON {
    let screen = CGRequestScreenCaptureAccess()
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(opts)
    return ["screen": screen, "accessibility": ax]
}

/// The app that owns keyboard focus right now. NSWorkspace's cached value only
/// refreshes on a running main run loop, which this stdin-driven process lacks,
/// so ask Accessibility first and pump the run loop for the fallback.
func frontmostApp() -> NSRunningApplication? {
    RunLoop.main.run(until: Date())
    if AXIsProcessTrusted() {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.25)
        if let el = axAttr(sys, kAXFocusedApplicationAttribute) {
            var pid: pid_t = 0
            if AXUIElementGetPid(el as! AXUIElement, &pid) == .success, pid > 0,
               let app = NSRunningApplication(processIdentifier: pid) { return app }
        }
    }
    return NSWorkspace.shared.frontmostApplication
}

let browserBundles: Set<String> = [
    "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary",
    "company.thebrowser.Browser", "company.thebrowser.dia", "com.brave.Browser", "com.microsoft.edgemac",
    "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
    "org.chromium.Chromium", "com.kagi.kagimacOS", "app.zen-browser.zen", "ai.perplexity.comet", "com.openai.atlas",
]

/// URL per browser window (AX), cached by window id + title for 30 s.
var windowURLCache: [String: (url: String?, at: Date)] = [:]

func browserWindowURLs(_ pid: pid_t, windows: [(id: Int, rect: CGRect, title: String)]) -> [Int: String] {
    var out: [Int: String] = [:]
    var misses: [(id: Int, rect: CGRect, key: String)] = []
    for w in windows {
        let key = "\(w.id)|\(w.title)"
        if let hit = windowURLCache[key], Date().timeIntervalSince(hit.at) < 30 {
            if let u = hit.url { out[w.id] = u }
        } else {
            misses.append((w.id, w.rect, key))
        }
    }
    guard !misses.isEmpty else { return out }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    let axWindows = (axAttr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    for m in misses {
        let match = axWindows.first { el in
            guard let f = axFrame(el) else { return false }
            return abs(f.origin.x - m.rect.origin.x) < 4 && abs(f.origin.y - m.rect.origin.y) < 4
                && abs(f.width - m.rect.width) < 4 && abs(f.height - m.rect.height) < 4
        }
        let url = match.flatMap { findWebURL($0, budget: 1500) }
        windowURLCache[m.key] = (url, Date())
        if let url { out[m.id] = url }
    }
    if windowURLCache.count > 500 { windowURLCache = windowURLCache.filter { Date().timeIntervalSince($0.value.at) < 30 } }
    return out
}

func windowList(focusedPid: pid_t?, focusedFrame: CGRect?, focusedURL: String?) -> [JSON] {
    // All on-screen windows, desktop elements included.
    let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    var out: [JSON] = []
    var focusedMarked = false
    var browserWindows: [pid_t: [(id: Int, rect: CGRect, title: String)]] = [:]
    for (z, w) in raw.enumerated() {
        guard let b = w[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: b as CFDictionary) else { continue }
        let pid = (w[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) } ?? 0
        if rect.width < 1 || rect.height < 1 { continue }
        let app = NSRunningApplication(processIdentifier: pid)
        // Skip windows of processes without a bundle (WindowServer
        // cursor/shield layers) and our own windows.
        guard let owner = app?.bundleIdentifier, !owner.isEmpty, !ownBundleIds.contains(owner),
              !ownExecutables.contains(app?.executableURL?.lastPathComponent ?? "") else { continue }
        var entry: JSON = [
            "pid": Int(pid),
            "bundle_id": app?.bundleIdentifier ?? "",
            "app_name": (w[kCGWindowOwnerName as String] as? String) ?? app?.localizedName ?? "",
            "title": (w[kCGWindowName as String] as? String) ?? "",
            "x": Int(rect.origin.x), "y": Int(rect.origin.y),
            "w": Int(rect.width), "h": Int(rect.height),
            "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
            "z": z,
            "is_user_app": app?.activationPolicy == .regular,
            "focused": false,
        ]
        let windowId = (w[kCGWindowNumber as String] as? Int) ?? 0
        entry["window_id"] = windowId
        let layer = entry["layer"] as? Int ?? 0
        if !focusedMarked, let fp = focusedPid, fp == pid, let ff = focusedFrame,
           abs(ff.origin.x - rect.origin.x) < 4, abs(ff.origin.y - rect.origin.y) < 4 {
            entry["focused"] = true
            focusedMarked = true
            if let focusedURL { entry["url"] = focusedURL }
        } else if layer == 0, let bid = app?.bundleIdentifier, browserBundles.contains(bid) {
            browserWindows[pid, default: []].append((windowId, rect, entry["title"] as? String ?? ""))
        }
        out.append(entry)
    }
    var urls: [Int: String] = [:]
    for (pid, wins) in browserWindows { urls.merge(browserWindowURLs(pid, windows: wins)) { a, _ in a } }
    if !urls.isEmpty {
        for i in out.indices where out[i]["url"] == nil {
            if let id = out[i]["window_id"] as? Int, let u = urls[id] { out[i]["url"] = u }
        }
    }
    return out
}

let ownBundleIds: Set<String> = ["ai.kortix.capture"]
let alwaysExcluded: Set<String> = ["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"]
/// Our own processes also count as "self" when run unbundled (dev builds).
let ownExecutables: Set<String> = ["kortix-capture", "kortix-capture-engine"]

func capture(_ req: JSON) -> JSON {
    let t0 = Date()
    let out = req["out"] as? String
    let maxHeight = req["max_height"] as? Int ?? 1440
    let maxWidth = req["max_width"] as? Int ?? 2560
    let quality = req["quality"] as? Double ?? 0.8
    let excludedBundles = Set(((req["exclude_bundle_ids"] as? [String]) ?? []).map { $0.lowercased() })
        .union(alwaysExcluded.map { $0.lowercased() })
    let excludedDomains = (req["exclude_domains"] as? [String]) ?? []
    let excludePrivate = req["exclude_private"] as? Bool ?? true
    let recordUnknown = req["record_unknown"] as? Bool ?? false
    let wantAX = req["ax"] as? Bool ?? false
    let axMaxDepth = req["ax_max_depth"] as? Int ?? 40
    let axMaxNodes = req["ax_max_nodes"] as? Int ?? 4000

    let idle = idleSeconds()
    var res: JSON = ["idle_seconds": idle]
    if screenLocked() { res["skipped"] = "locked"; return res }
    if let maxIdle = req["max_idle_seconds"] as? Double, maxIdle > 0, idle > maxIdle { res["skipped"] = "inactive"; return res }

    guard let front = frontmostApp() else { res["skipped"] = "no_frontmost_app"; return res }
    let bundleId = front.bundleIdentifier ?? ""
    res["app"] = [
        "pid": Int(front.processIdentifier), "bundle_id": bundleId,
        "name": front.localizedName ?? bundleId, "version": appVersion(front),
        "is_user_app": front.activationPolicy == .regular,
    ] as JSON
    if ownBundleIds.contains(bundleId) || ownExecutables.contains(front.executableURL?.lastPathComponent ?? "") {
        res["skipped"] = "self_on_screen"; return res
    }
    if bundleId.isEmpty && !recordUnknown { res["skipped"] = "unknown_bundle"; return res }
    if excludedBundles.contains(bundleId.lowercased()) { res["skipped"] = "excluded_app"; return res }

    // Focused window, URL and optional AX tree of the frontmost app.
    let axApp = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(axApp, 0.25)
    var focusedFrame: CGRect?
    var title: String?
    var url: String?
    if let fw = axAttr(axApp, kAXFocusedWindowAttribute) {
        let win = fw as! AXUIElement
        title = axString(win, kAXTitleAttribute)
        focusedFrame = axFrame(win)
        // Web page URL, else the window's document (file:// for editors, Finder, terminal cwd).
        url = findWebURL(win) ?? axString(win, "AXDocument").flatMap { $0.isEmpty ? nil : $0 }
        if wantAX {
            var budget = axMaxNodes
            if let tree = axTree(win, depth: 0, maxDepth: axMaxDepth, budget: &budget) {
                res["ax_tree"] = tree
                res["ax_node_count"] = axMaxNodes - budget
                res["ax_partial"] = budget <= 0
            }
        }
    }
    res["title"] = title ?? ""
    if let url { res["url"] = url }
    if let f = focusedFrame {
        res["focused_window"] = ["x": Int(f.origin.x), "y": Int(f.origin.y), "w": Int(f.width), "h": Int(f.height)] as JSON
    }
    if excludePrivate && looksPrivate(title: title) { res["skipped"] = "private_browsing"; return res }
    if let host = hostOf(url), domainMatches(host, excludedDomains) { res["skipped"] = "excluded_domain"; return res }

    res["windows"] = windowList(focusedPid: front.processIdentifier, focusedFrame: focusedFrame, focusedURL: url)
    guard let out else { return res }

    do {
        let (image, display) = try blocking { () async throws -> (CGImage, SCDisplay) in
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard !content.displays.isEmpty else { throw NSError(domain: "engine", code: 3, userInfo: [NSLocalizedDescriptionKey: "no_display"]) }
            // Capture the display that holds the focused window's center (CG global coords).
            var display = content.displays.first(where: { CGDisplayIsMain($0.displayID) != 0 }) ?? content.displays[0]
            if let f = focusedFrame {
                let c = CGPoint(x: f.midX, y: f.midY)
                if let d = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(c) }) { display = d }
            }
            let hide = content.applications.filter { excludedBundles.contains($0.bundleIdentifier.lowercased()) || ownBundleIds.contains($0.bundleIdentifier) }
            let filter = SCContentFilter(display: display, excludingApplications: hide, exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            let bounds = CGDisplayBounds(display.displayID)
            let mode = CGDisplayCopyDisplayMode(display.displayID)
            let pixelHeight = Double(mode?.pixelHeight ?? Int(bounds.height))
            let pixelWidth = Double(mode?.pixelWidth ?? Int(bounds.width))
            let scale = min(1.0, Double(maxHeight) / pixelHeight, Double(maxWidth) / pixelWidth)
            cfg.width = max(2, Int(pixelWidth * scale))
            cfg.height = max(2, Int(pixelHeight * scale))
            cfg.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            return (image, display)
        }
        try writeJPEG(image, to: out, quality: quality)
        let b = CGDisplayBounds(display.displayID)
        res["path"] = out
        res["width"] = image.width
        res["height"] = image.height
        res["display"] = ["id": Int(display.displayID), "x": b.origin.x, "y": b.origin.y, "w": b.width, "h": b.height] as JSON
        res["dhash"] = dhash(image)
    } catch {
        return ["ok": false, "error": "capture_failed: \(error.localizedDescription)", "permissions": permissions()]
    }
    res["elapsed_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    return res
}

func recognize(_ image: CGImage, _ req: JSON, offset: CGPoint = .zero) throws -> [JSON] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = (req["level"] as? String) == "fast" ? .fast : .accurate
    request.usesLanguageCorrection = req["language_correction"] as? Bool ?? false
    request.revision = VNRecognizeTextRequestRevision3
    if let langs = req["languages"] as? [String], !langs.isEmpty { request.recognitionLanguages = langs }
    else { request.automaticallyDetectsLanguage = true }
    try VNImageRequestHandler(cgImage: image).perform([request])
    let W = Double(image.width), H = Double(image.height)
    return (request.results ?? []).compactMap { obs in
        guard let cand = obs.topCandidates(1).first else { return nil }
        let r = obs.boundingBox // normalized, bottom-left origin
        return [
            "x": Int(r.minX * W + offset.x), "y": Int((1 - r.maxY) * H + offset.y),
            "w": max(1, Int(r.width * W)), "h": max(1, Int(r.height * H)),
            "text": cand.string, "confidence": Double(cand.confidence),
        ]
    }
}

func boxRect(_ b: JSON) -> CGRect {
    CGRect(x: b["x"] as? Int ?? 0, y: b["y"] as? Int ?? 0, width: b["w"] as? Int ?? 0, height: b["h"] as? Int ?? 0)
}

/// Grayscale thumbnail at 1/`div` scale, for change detection.
func grayThumb(_ image: CGImage, div: Int) -> (pixels: [UInt8], w: Int, h: Int) {
    let w = max(1, image.width / div), h = max(1, image.height / div)
    var px = [UInt8](repeating: 0, count: w * h)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    ctx.interpolationQuality = .low
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (px, w, h)
}

/// Rects (image pixels, top-left origin) covering areas that differ from `prev`.
/// Tiles are 32 px; changed tiles grow by one tile and merge into rectangles.
func changedRegions(_ cur: (pixels: [UInt8], w: Int, h: Int), _ prev: (pixels: [UInt8], w: Int, h: Int), div: Int, threshold: Int) -> [CGRect] {
    let tile = max(1, 32 / div) // thumbnail px per tile side (= 32 image px)
    let tw = (cur.w + tile - 1) / tile, th = (cur.h + tile - 1) / tile
    var changed = [Bool](repeating: false, count: tw * th)
    for y in 0..<cur.h { for x in 0..<cur.w {
        let i = y * cur.w + x
        if abs(Int(cur.pixels[i]) - Int(prev.pixels[i])) > threshold { changed[(y / tile) * tw + x / tile] = true }
    } }
    // Grow by one tile so glyphs on tile borders are read whole.
    var grown = changed
    for ty in 0..<th { for tx in 0..<tw where changed[ty * tw + tx] {
        for dy in -1...1 { for dx in -1...1 {
            let nx = tx + dx, ny = ty + dy
            if nx >= 0, ny >= 0, nx < tw, ny < th { grown[ny * tw + nx] = true }
        } }
    } }
    // Row runs, then merge vertically overlapping runs into rectangles.
    var rects: [CGRect] = []
    for ty in 0..<th {
        var tx = 0
        while tx < tw {
            guard grown[ty * tw + tx] else { tx += 1; continue }
            let start = tx
            while tx < tw && grown[ty * tw + tx] { tx += 1 }
            rects.append(CGRect(x: start, y: ty, width: tx - start, height: 1))
        }
    }
    var merged = true
    while merged {
        merged = false
        outer: for i in 0..<rects.count { for j in (i + 1)..<rects.count
            where rects[i].insetBy(dx: -0.5, dy: -0.5).intersects(rects[j]) {
            rects[i] = rects[i].union(rects[j]); rects.remove(at: j); merged = true; break outer
        } }
    }
    let scale = CGFloat(tile * div)
    return rects.map { CGRect(x: $0.minX * scale, y: $0.minY * scale, width: $0.width * scale, height: $0.height * scale) }
}

/// Last OCR'd image and boxes; the OCR worker sends frames in capture order,
/// so each frame is diffed against its predecessor.
var ocrCache: (thumb: (pixels: [UInt8], w: Int, h: Int), width: Int, height: Int, boxes: [JSON], sinceFull: Int)?

func ocr(_ req: JSON) -> JSON {
    guard let path = req["path"] as? String, let image = loadImage(path) else { return fail("image_not_found") }
    let t0 = Date()
    let div = req["diff_div"] as? Int ?? 2
    let threshold = req["diff_threshold"] as? Int ?? 24
    let pad = CGFloat(req["region_pad"] as? Int ?? 16)
    let thumb = grayThumb(image, div: div)
    let full = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    var mode = "full"
    var boxes: [JSON] = []
    var changedFraction = 1.0
    do {
        if req["incremental"] as? Bool == true, let cache = ocrCache, cache.width == image.width, cache.height == image.height,
           cache.thumb.w == thumb.w,
           cache.sinceFull < (req["full_every"] as? Int ?? 60) {
            var regions = changedRegions(thumb, cache.thumb, div: div, threshold: threshold)
                .map { $0.insetBy(dx: -pad, dy: -pad / 2).intersection(full) }.filter { !$0.isEmpty }
            // Re-read every old line a changed region touches.
            for (i, r) in regions.enumerated() {
                for b in cache.boxes where boxRect(b).intersects(r) { regions[i] = regions[i].union(boxRect(b).insetBy(dx: -4, dy: -4)) }
                regions[i] = regions[i].intersection(full)
            }
            let area = regions.reduce(0.0) { $0 + Double($1.width * $1.height) }
            changedFraction = area / Double(full.width * full.height)
            if regions.isEmpty {
                mode = "unchanged"
                boxes = cache.boxes
            } else if changedFraction < 0.45 && regions.count <= 16 {
                mode = "incremental"
                boxes = cache.boxes.filter { b in !regions.contains { boxRect(b).intersects($0) } }
                for r in regions {
                    guard let crop = image.cropping(to: r.integral) else { continue }
                    boxes += try recognize(crop, req, offset: r.integral.origin)
                }
            }
        }
        if mode == "full" { boxes = try recognize(image, req) }
    } catch {
        return fail("ocr_failed: \(error.localizedDescription)")
    }
    let sinceFull = mode == "full" ? 0 : (ocrCache?.sinceFull ?? 0) + 1
    ocrCache = (thumb, image.width, image.height, boxes, sinceFull)
    return ["boxes": boxes, "width": image.width, "height": image.height, "mode": mode,
            "changed_fraction": changedFraction, "elapsed_ms": Int(Date().timeIntervalSince(t0) * 1000)]
}

func icon(_ req: JSON) -> JSON {
    guard let bundleId = req["bundle_id"] as? String, let out = req["out"] as? String else { return fail("bad_request") }
    guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return fail("app_not_found") }
    let icon = NSWorkspace.shared.icon(forFile: appURL.path)
    let size = req["size"] as? Int ?? 64
    var rect = CGRect(x: 0, y: 0, width: size, height: size)
    guard let cg = icon.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return fail("icon_render") }
    do { try writePNG(cg, to: out) } catch { return fail("icon_write") }
    let name = FileManager.default.displayName(atPath: appURL.path).replacingOccurrences(of: ".app", with: "")
    return ["path": out, "dominant_color": dominantColor(cg), "display_name": name]
}

/// Encode staged frames into one H.264 (or HEVC on request) MP4 at 1 fps (frame i at t = i s).
func encode(_ req: JSON) -> JSON {
    guard let inputs = req["inputs"] as? [String], !inputs.isEmpty, let out = req["out"] as? String,
          let reqWidth = req["width"] as? Int, let reqHeight = req["height"] as? Int else { return fail("bad_request") }
    let quality = req["quality"] as? Double ?? 0.5
    // H.264 plays in every browser; HEVC is smaller but Chrome on Linux and most Firefox builds cannot decode it.
    let hevc = (req["codec"] as? String) == "hevc"
    // H.264 needs even dimensions.
    let width = hevc ? reqWidth : max(2, reqWidth & ~1), height = hevc ? reqHeight : max(2, reqHeight & ~1)
    let outURL = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: outURL)
    try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    do {
        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
        let settings: [String: Any] = [
            AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoQualityKey: quality,
                AVVideoMaxKeyFrameIntervalKey: 30,
                AVVideoAllowFrameReorderingKey: false,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        guard writer.canAdd(input) else { return fail("writer_input") }
        writer.add(input)
        guard writer.startWriting() else { return fail("writer_start: \(writer.error?.localizedDescription ?? "")") }
        writer.startSession(atSourceTime: .zero)
        var written = 0
        for (i, path) in inputs.enumerated() {
            guard let img = loadImage(path) else { continue }
            while !input.isReadyForMoreMediaData { usleep(2000) }
            guard let pool = adaptor.pixelBufferPool else { return fail("no_pool") }
            var pbOut: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut)
            guard let pb = pbOut else { return fail("no_pixel_buffer") }
            CVPixelBufferLockBaseAddress(pb, [])
            let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            ctx?.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
            CVPixelBufferUnlockBaseAddress(pb, [])
            if adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 1)) { written += 1 }
        }
        input.markAsFinished()
        let sema = DispatchSemaphore(value: 0)
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(inputs.count), timescale: 1))
        writer.finishWriting { sema.signal() }
        sema.wait()
        guard writer.status == .completed else { return fail("writer_failed: \(writer.error?.localizedDescription ?? "")") }
        let size = (try? FileManager.default.attributesOfItem(atPath: out)[.size] as? Int) ?? 0
        return ["path": out, "frames": written, "size_bytes": size]
    } catch {
        return fail("encode_failed: \(error.localizedDescription)")
    }
}

/// Chunk files may have no extension; tell AVFoundation the type.
func openVideo(_ path: String) -> AVURLAsset {
    AVURLAsset(url: URL(fileURLWithPath: path), options: [AVURLAssetOverrideMIMETypeKey: "video/mp4"])
}

/// Extract frame `index` from a 1 fps chunk; optional crop rect in image pixels.

func extract(_ req: JSON) -> JSON {
    guard let video = req["video"] as? String, let index = req["index"] as? Int, let out = req["out"] as? String else { return fail("bad_request") }
    let asset = openVideo(video)
    let gen = AVAssetImageGenerator(asset: asset)
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    gen.appliesPreferredTrackTransform = true
    do {
        var image = try gen.copyCGImage(at: CMTime(value: CMTimeValue(index), timescale: 1), actualTime: nil)
        if let c = req["crop"] as? JSON, let x = c["x"] as? Int, let y = c["y"] as? Int, let w = c["w"] as? Int, let h = c["h"] as? Int {
            let rect = CGRect(x: x, y: y, width: w, height: h).intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
            if !rect.isEmpty, let cropped = image.cropping(to: rect) { image = cropped }
        }
        if out.lowercased().hasSuffix(".jpg") || out.lowercased().hasSuffix(".jpeg") {
            try writeJPEG(image, to: out, quality: req["quality"] as? Double ?? 0.85)
        } else {
            try writePNG(image, to: out)
        }
        return ["path": out, "width": image.width, "height": image.height]
    } catch {
        return fail("extract_failed: \(error.localizedDescription)")
    }
}

/// Re-encode a chunk at a smaller scale (storage "downscale" action).
func transcode(_ req: JSON) -> JSON {
    guard let video = req["video"] as? String, let out = req["out"] as? String, let frames = req["frames"] as? Int else { return fail("bad_request") }
    let scale = req["scale"] as? Double ?? 0.5
    let asset = openVideo(video)
    let gen = AVAssetImageGenerator(asset: asset)
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent("kce-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmpDir) }
    var paths: [String] = []
    var w = 0, h = 0
    for i in 0..<frames {
        guard let img = try? gen.copyCGImage(at: CMTime(value: CMTimeValue(i), timescale: 1), actualTime: nil) else { continue }
        w = max(2, Int(Double(img.width) * scale) & ~1)
        h = max(2, Int(Double(img.height) * scale) & ~1)
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        let p = tmpDir.appendingPathComponent("\(i).jpg").path
        guard let small = ctx.makeImage(), (try? writeJPEG(small, to: p, quality: 0.9)) != nil else { continue }
        paths.append(p)
    }
    guard paths.count == frames else { return fail("transcode_read_failed: \(paths.count)/\(frames)") }
    var r = encode(["inputs": paths, "out": out, "width": w, "height": h, "quality": req["quality"] as? Double ?? 0.4])
    r["width"] = w; r["height"] = h
    return r
}

/// Crop or convert a staged still (JPEG) to PNG/JPEG.
func convert(_ req: JSON) -> JSON {
    guard let path = req["path"] as? String, let out = req["out"] as? String, var image = loadImage(path) else { return fail("bad_request") }
    if let c = req["crop"] as? JSON, let x = c["x"] as? Int, let y = c["y"] as? Int, let w = c["w"] as? Int, let h = c["h"] as? Int {
        let rect = CGRect(x: x, y: y, width: w, height: h).intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        if !rect.isEmpty, let cropped = image.cropping(to: rect) { image = cropped }
    }
    do {
        if out.lowercased().hasSuffix(".png") { try writePNG(image, to: out) } else { try writeJPEG(image, to: out, quality: 0.85) }
    } catch { return fail("convert_failed") }
    return ["path": out, "width": image.width, "height": image.height]
}

// MARK: - Main loop

setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine(strippingNewline: true) {
    autoreleasepool {
        guard let data = line.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? JSON,
              let cmd = req["cmd"] as? String else {
            emit(fail("bad_json"))
            return
        }
        var res: JSON
        switch cmd {
        case "ping": res = ["pong": true, "pid": Int(getpid())]
        case "permissions": res = permissions()
        case "request_permissions": res = requestPermissions()
        case "capture": res = capture(req)
        case "ocr": res = ocr(req)
        case "icon": res = icon(req)
        case "encode": res = encode(req)
        case "extract": res = extract(req)
        case "convert": res = convert(req)
        case "transcode": res = transcode(req)
        case "image_color":
            if let p = req["path"] as? String, let img = loadImage(p) { res = ["dominant_color": dominantColor(img), "width": img.width, "height": img.height] }
            else { res = fail("image_not_found") }
        default: res = fail("unknown_cmd: \(cmd)")
        }
        if let id = req["id"] { res["id"] = id }
        emit(res)
    }
}
