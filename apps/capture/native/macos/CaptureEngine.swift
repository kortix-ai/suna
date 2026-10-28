// kortix-capture-engine: native macOS sidecar for the capture recorder.
//
// Protocol: one JSON request per stdin line, one JSON response per stdout line.
// Every response carries `ok`; failures carry `error`. The Rust side
// (src/memory/engine.rs) owns policy, storage, and scheduling; this process
// only touches Apple frameworks (ScreenCaptureKit, Vision, AX, AVFoundation).
//
// Commands: ping, permissions, request_permissions, capture, ocr, icon,
// encode, extract, encode_audio, transcribe, audio_devices.
//
// Audio source mode (audio memory, src/memory/audio.rs):
//   kortix-capture-engine audio --source microphone [--device <uniqueID>]
//   kortix-capture-engine audio --source system [--exclude <bundle,ids>]
//   kortix-capture-engine audio --source file --path <file.wav>   (test seam)
// writes raw PCM (16 kHz, mono, s16le) to stdout and one JSON event per line
// to stderr ({"event":"started","device":…} or {"event":"error","error":…}).
// Exit codes: 0 the file ended, 1 error, 2 permission missing, 3 the device
// changed (the recorder restarts the source at once).

import AVFoundation
import AppKit
import AudioToolbox
import ApplicationServices
import CoreImage
import Foundation
import ImageIO
import ScreenCaptureKit
import Speech
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

/// The AX walk stops here so one slow app cannot stall a capture (the recorder times out at 6 s).
var axDeadline = Date.distantFuture
var axTimedOut = false

func axTree(_ el: AXUIElement, depth: Int, maxDepth: Int, budget: inout Int) -> JSON? {
    if Date() > axDeadline { axTimedOut = true; return nil }
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

/// The page's host by the one domain rule (memory::exclusions, fixtures/capture-format-v2/domains.json):
/// http(s) only, an address bar's scheme-less URL reads as https, no port, no trailing dot, no `www.`.
func hostOf(_ url: String?) -> String? {
    guard let raw = url?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
    let full = raw.contains("://") ? raw : "https://" + raw
    guard let comps = URLComponents(string: full), let scheme = comps.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          // encodedHost: an internationalized host in its ASCII (punycode) form, as the API stores it.
          var host = (comps.encodedHost ?? comps.host)?.lowercased() else { return nil }
    while host.hasSuffix(".") { host.removeLast() }
    if host.hasPrefix("www.") { host.removeFirst(4) }
    return host.isEmpty ? nil : host
}

/// `patterns` arrive normalized from Rust (`Settings::effective_excluded_domains`):
/// a pattern covers its host and every subdomain.
func domainMatches(_ host: String, _ patterns: [String]) -> Bool {
    patterns.contains { p in !p.isEmpty && (host == p || host.hasSuffix("." + p)) }
}

/// One app identifier as the app rule compares it (memory::exclusions::app_key):
/// trimmed, lowercase, its last path component, without `.exe`, `.app`,
/// `.desktop` or `.appimage` and without the `maccatalyst.` prefix.
func appKey(_ id: String) -> String {
    var s = id.trimmingCharacters(in: .whitespacesAndNewlines)
    while s.hasSuffix("/") || s.hasSuffix("\\") { s.removeLast() }
    s = s.lowercased()
    if let i = s.lastIndex(where: { $0 == "/" || $0 == "\\" }) { s = String(s[s.index(after: i)...]) }
    for suffix in [".exe", ".app", ".desktop", ".appimage"] where s.hasSuffix(suffix) {
        s = String(s.dropLast(suffix.count)); break
    }
    if s.hasPrefix("maccatalyst.") { s = String(s.dropFirst("maccatalyst.".count)) }
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The one app rule (memory::exclusions::app_matches, fixtures/capture-format-v2/apps.json):
/// `entry` names the app when its key equals the key of any of the app's `ids`
/// (bundle id, app name, executable and bundle file names). An entry ending in `*`
/// names every app with an id key that starts with the rest (3 bytes or more).
func appMatches(_ entry: String, _ ids: [String]) -> Bool {
    let e = appKey(entry)
    let keys = ids.map(appKey)
    if e.hasSuffix("*") {
        let prefix = String(e.dropLast())
        return prefix.utf8.count >= 3 && keys.contains { $0.hasPrefix(prefix) }
    }
    return !e.isEmpty && keys.contains(e)
}

func appListed(_ list: [String], _ ids: [String]) -> Bool { list.contains { appMatches($0, ids) } }

/// Every identifier of a running app: bundle id, app name, executable and bundle file names.
func appIds(_ app: NSRunningApplication?, bundle: String = "", name: String = "") -> [String] {
    [bundle, name, app?.bundleIdentifier ?? "", app?.localizedName ?? "",
     app?.executableURL?.lastPathComponent ?? "", app?.bundleURL?.lastPathComponent ?? ""].filter { !$0.isEmpty }
}

func appIds(_ app: SCRunningApplication) -> [String] {
    appIds(NSRunningApplication(processIdentifier: app.processID), bundle: app.bundleIdentifier, name: app.applicationName)
}

/// `_app_match`: the rule above against the shared vectors (tests only).
func appMatchCommand(_ req: JSON) -> JSON {
    let ids = [req["bundle_id"] as? String ?? ""] + ((req["aliases"] as? [String]) ?? [])
    return ["ok": true, "key": appKey(req["entry"] as? String ?? ""), "match": appMatches(req["entry"] as? String ?? "", ids)]
}

/// Record only included apps and websites (`only_included`, `include_bundle_ids`,
/// `include_domains` of the request). Off: everything not excluded is recorded.
struct Include {
    var on = false
    var apps: [String] = []
    var domains: [String] = []
    init(_ req: JSON) {
        on = req["only_included"] as? Bool ?? false
        apps = (req["include_bundle_ids"] as? [String]) ?? []
        domains = ((req["include_domains"] as? [String]) ?? []).map { $0.lowercased() }
    }
    /// The app is included, or the page's website is. Off: always true.
    func allows(_ ids: [String], _ url: String?) -> Bool {
        !on || appListed(apps, ids) || (hostOf(url).map { domainMatches($0, domains) } ?? false)
    }
}

/// `_domain_match`: the rule above against the shared vectors (tests only).
func domainMatchCommand(_ req: JSON) -> JSON {
    let host = hostOf(req["url"] as? String)
    return ["ok": true, "host": host as Any, "match": host.map { domainMatches($0, req["patterns"] as? [String] ?? []) } ?? false]
}

// MARK: - Image helpers

func jpegData(_ image: CGImage, quality: Double) throws -> Data {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw NSError(domain: "engine", code: 1, userInfo: [NSLocalizedDescriptionKey: "jpeg_dest"])
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
        throw NSError(domain: "engine", code: 2, userInfo: [NSLocalizedDescriptionKey: "jpeg_encode"])
    }
    return data as Data
}

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

/// Microphone access as TCC reports it. Reading it never prompts.
func microphoneState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "not_determined"
    }
}

func permissions() -> JSON {
    ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
     "input_monitoring": CGPreflightListenEventAccess(), "microphone": microphoneState()]
}

/// The one command that shows macOS permission prompts. Only an explicit user
/// action sends it (`permissions --request`, an "Allow" button); every start
/// path checks without asking. `only` names the permissions to ask for
/// (screen, accessibility, input_monitoring, microphone); without it, Screen
/// Recording and Accessibility, plus the Microphone when the request names it.
/// A permission already granted is not asked again. Answers `permissions()`.
func requestPermissions(_ req: JSON) -> JSON {
    let only = req["only"] as? [String]
    func wants(_ key: String) -> Bool {
        if let only { return only.contains(key) }
        return key == "screen" || key == "accessibility" || (key == "microphone" && req["microphone"] as? Bool == true)
    }
    if wants("screen") && !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    if wants("accessibility") && !AXIsProcessTrusted() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }
    if wants("input_monitoring") && !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
    if wants("microphone") && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let sema = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in sema.signal() }
        sema.wait()
    }
    return permissions()
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

/// The display the user works on: the one holding most of the focused window, else most of
/// the frontmost app's top window (AX can miss the focused window), else the one under the
/// mouse, else the main display. All rects are CG global coordinates (top-left origin).
func activeDisplay(_ displays: [SCDisplay], focusedFrame: CGRect?, frontPid: pid_t) -> (SCDisplay, String) {
    func overlap(_ d: SCDisplay, _ r: CGRect) -> CGFloat {
        let i = CGDisplayBounds(d.displayID).intersection(r)
        return i.isNull ? 0 : i.width * i.height
    }
    func most(_ r: CGRect?) -> SCDisplay? {
        guard let r, let best = displays.max(by: { overlap($0, r) < overlap($1, r) }), overlap(best, r) > 0 else { return nil }
        return best
    }
    let topWindow = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
        .first { ($0[kCGWindowOwnerPID as String] as? pid_t) == frontPid && ($0[kCGWindowLayer as String] as? Int) == 0 }
        .flatMap { ($0[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } }
    if let d = most(focusedFrame) { return (d, "focused_window") }
    if let d = most(topWindow) { return (d, "top_window") }
    let m = NSEvent.mouseLocation  // Cocoa: bottom-left origin of the main display
    let mouse = CGPoint(x: m.x, y: CGDisplayBounds(CGMainDisplayID()).height - m.y)
    if let d = displays.first(where: { CGDisplayBounds($0.displayID).contains(mouse) }) { return (d, "mouse") }
    return (displays.first { CGDisplayIsMain($0.displayID) != 0 } ?? displays[0], "main")
}

func windowList(focusedPid: pid_t?, focusedFrame: CGRect?, focusedURL: String?, own: Set<String> = []) -> [JSON] {
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
        guard let owner = app?.bundleIdentifier, !owner.isEmpty, !isOwn(owner, own),
              !ownExecutables.contains(app?.executableURL?.lastPathComponent ?? "") else { continue }
        var entry: JSON = [
            "pid": Int(pid),
            "bundle_id": app?.bundleIdentifier ?? "",
            "aliases": appIds(app),
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

let ownBundleIds: Set<String> = ["ai.kortix.capture", "ai.kortix.capture.tray"]

/// Kortix itself, never recorded: every com.kortix.* and ai.kortix.* app, and
/// the app the service runs in (`own_bundle_ids` of the request).
func isOwn(_ bundle: String, _ extra: Set<String>) -> Bool {
    let b = bundle.lowercased()
    return b.hasPrefix("com.kortix.") || b.hasPrefix("ai.kortix.") || ownBundleIds.contains(bundle) || extra.contains(b)
}
let alwaysExcluded: Set<String> = ["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"]
/// Our own processes also count as "self" when run unbundled (dev builds).
let ownExecutables: Set<String> = ["kortix-capture", "kortix-tray", "kortix-capture-engine"]

func capture(_ req: JSON) -> JSON {
    if req["all_displays"] as? Bool == true { return captureAll(req) }
    let t0 = Date()
    let out = req["out"] as? String
    let maxHeight = req["max_height"] as? Int ?? 1440
    let maxWidth = req["max_width"] as? Int ?? 2560
    let quality = req["quality"] as? Double ?? 0.8
    let excludedApps = ((req["exclude_bundle_ids"] as? [String]) ?? []) + alwaysExcluded
    let excludedDomains = (req["exclude_domains"] as? [String]) ?? []
    let excludePrivate = req["exclude_private"] as? Bool ?? true
    let recordUnknown = req["record_unknown"] as? Bool ?? false
    let wantAX = req["ax"] as? Bool ?? false
    let axMaxDepth = req["ax_max_depth"] as? Int ?? 40
    let axMaxNodes = req["ax_max_nodes"] as? Int ?? 4000

    let idle = idleSeconds()
    var res: JSON = ["idle_seconds": idle]
    // Check only. Without Screen Recording, ScreenCaptureKit raises the macOS
    // prompt on every call; the recorder would raise it every tick. The one
    // asking path is `request_permissions` (an explicit user action).
    if out != nil && !CGPreflightScreenCaptureAccess() {
        res["skipped"] = "permission_missing"; res["permission"] = "screen"; return res
    }
    if screenLocked() { res["skipped"] = "locked"; return res }
    // Input idleness never stops capture (reading and watching record too): it marks the frame.
    if let after = (req["inactive_after_seconds"] ?? req["max_idle_seconds"]) as? Double, after > 0, idle > after { res["inactive"] = true }

    // Test captures target the synthetic task process even if another app
    // takes focus. Its independent-window filter below keeps evidence scoped.
    let captureApp = (req["_test_window_pid"] as? Int).flatMap { NSRunningApplication(processIdentifier: pid_t($0)) } ?? frontmostApp()
    guard let front = captureApp else { res["skipped"] = "no_frontmost_app"; return res }
    let frontPid = front.processIdentifier
    let bundleId = front.bundleIdentifier ?? ""
    let frontIds = appIds(front)
    res["app"] = [
        "pid": Int(front.processIdentifier), "bundle_id": bundleId, "aliases": frontIds,
        "name": front.localizedName ?? bundleId, "version": appVersion(front),
        "is_user_app": front.activationPolicy == .regular,
    ] as JSON
    if isOwn(bundleId, []) || ownExecutables.contains(front.executableURL?.lastPathComponent ?? "") {
        res["skipped"] = "self_on_screen"; return res
    }
    if bundleId.isEmpty && !recordUnknown { res["skipped"] = "unknown_bundle"; return res }
    if !bundleId.isEmpty && appListed(excludedApps, frontIds) { res["skipped"] = "excluded_app"; return res }

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
            axDeadline = Date().addingTimeInterval(1.5)
            axTimedOut = false
            if let tree = axTree(win, depth: 0, maxDepth: axMaxDepth, budget: &budget) {
                res["ax_tree"] = tree
                res["ax_node_count"] = axMaxNodes - budget
                res["ax_partial"] = budget <= 0 || axTimedOut
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
    let include = Include(req)
    // Record only included fails closed: an app without a bundle id is never included.
    if (bundleId.isEmpty && include.on) || !include.allows(frontIds, url) { res["skipped"] = "not_included"; return res }

    res["windows"] = windowList(focusedPid: front.processIdentifier, focusedFrame: focusedFrame, focusedURL: url)
    guard let out else { return res }

    do {
        let (image, display, via) = try blocking { () async throws -> (CGImage, SCDisplay, String) in
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard !content.displays.isEmpty else { throw NSError(domain: "engine", code: 3, userInfo: [NSLocalizedDescriptionKey: "no_display"]) }
            let (display, via) = activeDisplay(content.displays, focusedFrame: focusedFrame, frontPid: frontPid)
            // Record only included: every other app is hidden too; the front app passed the check above.
            let hide = content.applications.filter {
                appListed(excludedApps, appIds($0)) || isOwn($0.bundleIdentifier, [])
                    || (include.on && $0.processID != frontPid && !appListed(include.apps, appIds($0)))
            }
            let filter: SCContentFilter
            if let testPid = req["_test_window_pid"] as? Int {
                // The synthetic verification harness scopes screenshots to
                // its own fullscreen window, so desktop/Space transitions
                // cannot put unrelated user content in test artifacts.
                guard testPid == Int(frontPid),
                      let window = content.windows.filter({ $0.owningApplication?.processID == frontPid })
                        .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                    throw NSError(domain: "engine", code: 4, userInfo: [NSLocalizedDescriptionKey: "synthetic_window_not_found"])
                }
                filter = SCContentFilter(desktopIndependentWindow: window)
            } else {
                filter = SCContentFilter(display: display, excludingApplications: hide, exceptingWindows: [])
            }
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
            return (image, display, via)
        }
        if req["cmd"] as? String == "capture_private" {
            // Raw pixels and recognized text travel only over the local pipe.
            // The Rust recorder masks them before the first file/DB write.
            res["boxes"] = try recognize(image, req)
            res["image_base64"] = try jpegData(image, quality: quality).base64EncodedString()
            res["privacy_capture"] = true
        } else {
            try writeJPEG(image, to: out, quality: quality)
        }
        let b = CGDisplayBounds(display.displayID)
        res["path"] = out
        res["width"] = image.width
        res["height"] = image.height
        res["display"] = ["id": Int(display.displayID), "x": b.origin.x, "y": b.origin.y, "w": b.width, "h": b.height, "via": via] as JSON
        res["dhash"] = dhash(image)
    } catch {
        return ["ok": false, "error": "capture_failed: \(error.localizedDescription)", "permissions": permissions()]
    }
    res["elapsed_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    return res
}


// MARK: - Every display

/// NSScreen's name ("LG ULTRAWIDE", "Built-in Retina Display") and backing scale of a display.
func screenInfo(_ id: CGDirectDisplayID) -> (name: String, scale: Double) {
    for screen in NSScreen.screens {
        if let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == id {
            return (screen.localizedName, Double(screen.backingScaleFactor))
        }
    }
    return ("Display \(id)", 1)
}

/// FNV-1a over a 256-pixel-wide grayscale copy: an equal hash means the display did not change.
func contentHash(_ image: CGImage) -> String {
    let w = 256
    let h = max(1, Int((Double(image.height) * Double(w) / Double(max(1, image.width))).rounded()))
    var pixels = [UInt8](repeating: 0, count: w * h)
    let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    ctx.interpolationQuality = .low
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    var hash: UInt64 = 0xcbf29ce484222325
    for b in pixels { hash ^= UInt64(b); hash = hash &* 0x100000001b3 }
    return String(format: "%016llx", hash)
}

func jsonRect(_ w: JSON) -> CGRect {
    func n(_ k: String) -> Double { (w[k] as? Double) ?? Double(w[k] as? Int ?? 0) }
    return CGRect(x: n("x"), y: n("y"), width: n("w"), height: n("h"))
}

/// What every display shows, from the window list (front to back): the windows
/// hidden on every display (an excluded app, an unknown app, a private window, an
/// excluded website), whether a hidden window fully covers a display (no frame of
/// it), and each display's top visible window (its app, title and URL name the frame).
func planDisplays(windows: [JSON], displays: [(id: Int, rect: CGRect)], excludedApps: [String],
                  excludedDomains: [String], excludePrivate: Bool, recordUnknown: Bool, own: Set<String> = [],
                  include: Include = Include([:]))
    -> (hidden: Set<Int>, covered: Set<Int>, top: [Int: JSON]) {
    func isHidden(_ w: JSON) -> Bool {
        let bundle = (w["bundle_id"] as? String ?? "").lowercased()
        if bundle.isEmpty { return !recordUnknown || include.on }
        let ids = [bundle] + ((w["aliases"] as? [String]) ?? [])
        if isOwn(bundle, own) { return true }
        if appListed(excludedApps, ids) { return true }
        if excludePrivate && looksPrivate(title: w["title"] as? String) { return true }
        if let host = hostOf(w["url"] as? String), domainMatches(host, excludedDomains) { return true }
        return !include.allows(ids, w["url"] as? String)
    }
    var hidden = Set<Int>()
    var covered = Set<Int>()
    var top: [Int: JSON] = [:]
    for w in windows where isHidden(w) { hidden.insert(w["window_id"] as? Int ?? -1) }
    for d in displays {
        let area = d.rect.width * d.rect.height
        for w in windows where (w["layer"] as? Int ?? 0) == 0 {
            let overlap = jsonRect(w).intersection(d.rect)
            guard !overlap.isNull, overlap.width * overlap.height > 0 else { continue }
            if hidden.contains(w["window_id"] as? Int ?? -1) {
                // Covered only when nothing visible lies in front of it on this display.
                if top[d.id] == nil, overlap.width * overlap.height >= 0.95 * area { covered.insert(d.id); break }
                continue
            }
            if top[d.id] == nil { top[d.id] = w }
        }
        // Record only included: a display with no included window writes no frame.
        if include.on && top[d.id] == nil { covered.insert(d.id) }
    }
    return (hidden, covered, top)
}

/// `_plan_displays`: the plan of synthetic windows and displays (tests only).
func planDisplaysCommand(_ req: JSON) -> JSON {
    let displays = ((req["displays"] as? [JSON]) ?? []).map { (id: $0["id"] as? Int ?? 0, rect: jsonRect($0)) }
    let plan = planDisplays(
        windows: (req["windows"] as? [JSON]) ?? [], displays: displays,
        excludedApps: (req["exclude_bundle_ids"] as? [String]) ?? [],
        excludedDomains: (req["exclude_domains"] as? [String]) ?? [],
        excludePrivate: req["exclude_private"] as? Bool ?? true, recordUnknown: req["record_unknown"] as? Bool ?? false,
        own: Set(((req["own_bundle_ids"] as? [String]) ?? []).map { $0.lowercased() }), include: Include(req))
    return ["ok": true, "hidden": Array(plan.hidden), "displays": displays.map { d -> JSON in
        var out: JSON = ["id": d.id, "covered": plan.covered.contains(d.id)]
        if let t = plan.top[d.id] { out["top"] = ["bundle_id": t["bundle_id"] ?? "", "title": t["title"] ?? "", "url": t["url"] ?? NSNull()] as JSON }
        return out
    }]
}

/// Every connected display, each tick. The display holding the focused window is
/// captured first; another display is skipped only while its content hash equals
/// `unchanged[<id>]`. Excluded apps, private windows and excluded websites are hidden
/// window by window on every display; a display a hidden window fully covers writes
/// nothing. Idleness only marks the capture inactive.
func captureAll(_ req: JSON) -> JSON {
    let t0 = Date()
    let out = req["out"] as? String ?? ""
    let maxHeight = req["max_height"] as? Int ?? 1440
    let maxWidth = req["max_width"] as? Int ?? 2560
    let quality = req["quality"] as? Double ?? 0.8
    let excludedApps = ((req["exclude_bundle_ids"] as? [String]) ?? []) + alwaysExcluded
    let excludedDomains = (req["exclude_domains"] as? [String]) ?? []
    let excludePrivate = req["exclude_private"] as? Bool ?? true
    let recordUnknown = req["record_unknown"] as? Bool ?? false
    let wantAX = req["ax"] as? Bool ?? false
    let unchanged = (req["unchanged"] as? [String: String]) ?? [:]
    let isPrivate = req["cmd"] as? String == "capture_private"
    let own = Set(((req["own_bundle_ids"] as? [String]) ?? []).map { $0.lowercased() })
    let include = Include(req)

    let idle = idleSeconds()
    var res: JSON = ["idle_seconds": idle]
    if let after = req["inactive_after_seconds"] as? Double, after > 0, idle > after { res["inactive"] = true }
    if !CGPreflightScreenCaptureAccess() { res["skipped"] = "permission_missing"; res["permission"] = "screen"; return res }
    if screenLocked() { res["skipped"] = "locked"; return res }

    // The front app names the focused display's frame, unless its window is hidden.
    let front = frontmostApp()
    let frontPid = front?.processIdentifier ?? 0
    let frontBundle = front?.bundleIdentifier ?? ""
    if frontBundle == "com.apple.ScreenSaver.Engine" { res["skipped"] = "screensaver"; return res }
    let frontOwn = isOwn(frontBundle, own) || ownExecutables.contains(front?.executableURL?.lastPathComponent ?? "")
    let frontIds = appIds(front)
    let frontExcluded = front == nil || frontOwn || (!frontBundle.isEmpty && appListed(excludedApps, frontIds))
        || (frontBundle.isEmpty && (!recordUnknown || include.on))
    var focusedFrame: CGRect?
    var title: String?
    var url: String?
    var axWindow: AXUIElement?
    if let front, !frontExcluded {
        let axApp = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(axApp, 0.25)
        if let fw = axAttr(axApp, kAXFocusedWindowAttribute) {
            let win = fw as! AXUIElement
            title = axString(win, kAXTitleAttribute)
            focusedFrame = axFrame(win)
            url = findWebURL(win) ?? axString(win, "AXDocument").flatMap { $0.isEmpty ? nil : $0 }
            axWindow = win
        }
    }
    let focusedHidden = frontExcluded || (excludePrivate && looksPrivate(title: title))
        || (hostOf(url).map { domainMatches($0, excludedDomains) } ?? false)
        || !include.allows(frontIds, url)
    if !focusedHidden, let front {
        res["app"] = ["pid": Int(frontPid), "bundle_id": frontBundle, "aliases": frontIds, "name": front.localizedName ?? frontBundle,
                      "version": appVersion(front), "is_user_app": front.activationPolicy == .regular] as JSON
        res["title"] = title ?? ""
        if let url { res["url"] = url }
        if let f = focusedFrame { res["focused_window"] = ["x": Int(f.origin.x), "y": Int(f.origin.y), "w": Int(f.width), "h": Int(f.height)] as JSON }
        if wantAX, let win = axWindow {
            let maxNodes = req["ax_max_nodes"] as? Int ?? 4000
            var budget = maxNodes
            axDeadline = Date().addingTimeInterval(1.5)
            axTimedOut = false
            if let tree = axTree(win, depth: 0, maxDepth: req["ax_max_depth"] as? Int ?? 40, budget: &budget) {
                res["ax_tree"] = tree
                res["ax_node_count"] = maxNodes - budget
                res["ax_partial"] = budget <= 0 || axTimedOut
            }
        }
    }

    let tFront = Date()
    let allWindows = windowList(focusedPid: focusedHidden ? nil : frontPid, focusedFrame: focusedFrame, focusedURL: url, own: own)
    let windowsMs = Int(Date().timeIntervalSince(tFront) * 1000)
    do {
        let tContent = Date()
        let content = try blocking { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        res["stage_ms"] = ["front_ax": Int(tFront.timeIntervalSince(t0) * 1000), "windows": windowsMs,
                           "shareable_content": Int(Date().timeIntervalSince(tContent) * 1000)] as JSON
        guard !content.displays.isEmpty else { return ["ok": false, "error": "capture_failed: no_display"] }
        let (focusedDisplay, via) = activeDisplay(content.displays, focusedFrame: focusedFrame, frontPid: frontPid)
        // `only_focused`: a capture a focus change pulled forward records the active display only.
        let ordered = [focusedDisplay] + (req["only_focused"] as? Bool == true ? []
            : content.displays.filter { $0.displayID != focusedDisplay.displayID })
        let plan = planDisplays(windows: allWindows, displays: ordered.map { (id: Int($0.displayID), rect: CGDisplayBounds($0.displayID)) },
                                excludedApps: excludedApps, excludedDomains: excludedDomains,
                                excludePrivate: excludePrivate, recordUnknown: recordUnknown, own: own, include: include)
        // Hidden windows never reach a frame, and neither do their titles or URLs.
        res["windows"] = allWindows.filter { !plan.hidden.contains($0["window_id"] as? Int ?? -1) }
        // Record only included: an app with no visible (included) window is hidden whole,
        // so its panels, popovers and notifications never reach a frame either.
        let visiblePids = Set(allWindows.filter { !plan.hidden.contains($0["window_id"] as? Int ?? -1) }.compactMap { $0["pid"] as? Int })
        let hideApps = content.applications.filter {
            appListed(excludedApps, appIds($0)) || isOwn($0.bundleIdentifier, own)
                || ((!recordUnknown || include.on) && $0.bundleIdentifier.isEmpty)
                || (include.on && !appListed(include.apps, appIds($0)) && !visiblePids.contains(Int($0.processID)))
        }
        let hideAppPids = Set(hideApps.map { $0.processID })
        let hiddenSC = content.windows.filter {
            plan.hidden.contains(Int($0.windowID)) || hideAppPids.contains($0.owningApplication?.processID ?? -1)
        }
        let stem = out.hasSuffix(".jpg") ? String(out.dropLast(4)) : out
        var entries: [JSON] = []
        var timings: [JSON] = []
        for display in ordered {
            let t = Date()
            let id = Int(display.displayID)
            let b = CGDisplayBounds(display.displayID)
            let (name, scale) = screenInfo(display.displayID)
            var entry: JSON = ["display": ["id": id, "name": name, "x": b.origin.x, "y": b.origin.y, "w": b.width, "h": b.height,
                                           "scale": scale, "main": CGDisplayIsMain(display.displayID) != 0,
                                           "focused": display.displayID == focusedDisplay.displayID,
                                           "via": display.displayID == focusedDisplay.displayID ? via : "other"] as JSON]
            if plan.covered.contains(id) {
                entry["skipped"] = "excluded"
                entries.append(entry); timings.append(["id": id, "ms": Int(Date().timeIntervalSince(t) * 1000)]); continue
            }
            let filter = hiddenSC.isEmpty
                ? SCContentFilter(display: display, excludingApplications: hideApps, exceptingWindows: [])
                : SCContentFilter(display: display, excludingWindows: hiddenSC)
            let cfg = SCStreamConfiguration()
            let mode = CGDisplayCopyDisplayMode(display.displayID)
            let pixelHeight = Double(mode?.pixelHeight ?? Int(b.height))
            let pixelWidth = Double(mode?.pixelWidth ?? Int(b.width))
            let fit = min(1.0, Double(maxHeight) / pixelHeight, Double(maxWidth) / pixelWidth)
            cfg.width = max(2, Int(pixelWidth * fit))
            cfg.height = max(2, Int(pixelHeight * fit))
            cfg.showsCursor = false
            let tCap = Date()
            let image = try blocking { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) }
            let captureMs = Int(Date().timeIntervalSince(tCap) * 1000)
            let tHash = Date()
            let hash = contentHash(image)
            let hashMs = Int(Date().timeIntervalSince(tHash) * 1000)
            var writeMs = 0, dhashMs = 0
            entry["content_hash"] = hash
            if unchanged[String(id)] == hash {
                entry["unchanged"] = true
            } else {
                let path = "\(stem)_d\(id).jpg"
                let tWrite = Date()
                if isPrivate {
                    entry["boxes"] = try recognize(image, req)
                    entry["image_base64"] = try jpegData(image, quality: quality).base64EncodedString()
                    entry["privacy_capture"] = true
                } else {
                    try writeJPEG(image, to: path, quality: quality)
                }
                writeMs = Int(Date().timeIntervalSince(tWrite) * 1000)
                entry["path"] = path
                entry["width"] = image.width
                entry["height"] = image.height
                let tD = Date()
                entry["dhash"] = dhash(image)
                dhashMs = Int(Date().timeIntervalSince(tD) * 1000)
                if let top = plan.top[id] {
                    entry["app"] = ["pid": top["pid"] ?? 0, "bundle_id": top["bundle_id"] ?? "", "name": top["app_name"] ?? ""] as JSON
                    entry["title"] = top["title"] ?? ""
                    if let u = top["url"] as? String { entry["url"] = u }
                } else {
                    entry["app"] = ["bundle_id": "com.apple.finder", "name": "Finder"] as JSON
                    entry["title"] = ""
                }
            }
            let ms = Int(Date().timeIntervalSince(t) * 1000)
            entry["elapsed_ms"] = ms
            entries.append(entry)
            timings.append(["id": id, "ms": ms, "capture": captureMs, "hash": hashMs, "jpeg": writeMs, "dhash": dhashMs,
                            "px": image.width * image.height, "written": entry["path"] != nil])
        }
        res["displays"] = entries
        res["timings"] = timings
    } catch {
        return ["ok": false, "error": "capture_failed: \(error.localizedDescription)", "permissions": permissions()]
    }
    res["elapsed_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    return res
}

/// Cheap change detector for the recorder's change-driven capture: frontmost app, focused
/// window title and URL. No screenshot, no AX tree walk, no window list. A browser URL
/// search is capped at 600 AX nodes (a capture allows 2500).
func probe(_ req: JSON) -> JSON {
    var res: JSON = [:]
    if screenLocked() { res["skipped"] = "locked"; return res }
    guard let front = frontmostApp() else { res["skipped"] = "no_frontmost_app"; return res }
    let bundleId = front.bundleIdentifier ?? ""
    res["app"] = ["pid": Int(front.processIdentifier), "bundle_id": bundleId, "aliases": appIds(front),
                  "name": front.localizedName ?? bundleId] as JSON
    if isOwn(bundleId, []) || ownExecutables.contains(front.executableURL?.lastPathComponent ?? "") {
        res["skipped"] = "self_on_screen"; return res
    }
    let axApp = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(axApp, 0.25)
    var title = ""
    if let fw = axAttr(axApp, kAXFocusedWindowAttribute) {
        let win = fw as! AXUIElement
        title = axString(win, kAXTitleAttribute) ?? ""
        let url = browserBundles.contains(bundleId)
            ? findWebURL(win, budget: 600)
            : axString(win, "AXDocument").flatMap { $0.isEmpty ? nil : $0 }
        if let url { res["url"] = url }
    }
    res["title"] = title
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

/// Last OCR'd image and boxes per `cache_key` (the display): the OCR worker sends
/// each display's frames in capture order, so each frame is diffed against the
/// previous frame of its own display.
var ocrCaches: [String: (thumb: (pixels: [UInt8], w: Int, h: Int), width: Int, height: Int, boxes: [JSON], sinceFull: Int)] = [:]

func ocr(_ req: JSON) -> JSON {
    guard let path = req["path"] as? String, let image = loadImage(path) else { return fail("image_not_found") }
    let t0 = Date()
    let div = req["diff_div"] as? Int ?? 2
    let threshold = req["diff_threshold"] as? Int ?? 24
    let pad = CGFloat(req["region_pad"] as? Int ?? 16)
    let thumb = grayThumb(image, div: div)
    let full = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    let key = req["cache_key"] as? String ?? ""
    let ocrCache = ocrCaches[key]
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
    ocrCaches[key] = (thumb, image.width, image.height, boxes, sinceFull)
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

/// Encode staged frames into one HEVC MP4 at 1 fps (frame i at t = i s).
func encode(_ req: JSON) -> JSON {
    guard let inputs = req["inputs"] as? [String], !inputs.isEmpty, let out = req["out"] as? String,
          let width = req["width"] as? Int, let height = req["height"] as? Int else { return fail("bad_request") }
    let quality = req["quality"] as? Double ?? 0.5
    let outURL = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: outURL)
    try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    do {
        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.hevc,
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


// MARK: - Audio memory

let audioTarget = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

func audioEvent(_ obj: JSON) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardError.write(data)
    FileHandle.standardError.write("\n".data(using: .utf8)!)
}

func audioFail(_ message: String, code: Int32, permission: Bool = false) -> Never {
    audioEvent(["event": "error", "error": message, "permission": permission])
    exit(code)
}

/// Converts any PCM the OS delivers to 16 kHz mono s16le and writes it to stdout.
final class PcmWriter {
    private var converter: AVAudioConverter?
    private var source: AVAudioFormat?
    private let lock = NSLock()

    func write(_ input: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        if source != input.format {
            source = input.format
            converter = AVAudioConverter(from: input.format, to: audioTarget)
        }
        guard let converter, input.frameLength > 0 else { return }
        let ratio = audioTarget.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: audioTarget, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return input
        }
        guard error == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        FileHandle.standardOutput.write(Data(bytes: ch[0], count: Int(out.frameLength) * 2))
    }

    func write(_ sample: CMSampleBuffer) {
        guard let desc = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        buffer.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames),
                                                           into: buffer.mutableAudioBufferList) == noErr else { return }
        write(buffer)
    }
}

final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    let pcm = PcmWriter()
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio { pcm.write(sample) }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        audioFail("system audio stopped: \(error.localizedDescription)", code: 1)
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        pcm.write(sample)
    }
}

let audioCapture = AudioCapture()
let audioQueue = DispatchQueue(label: "ai.kortix.capture.audio")
var audioTimers: [DispatchSourceTimer] = []

func every(_ seconds: Double, _ body: @escaping () -> Void) {
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + seconds, repeating: seconds)
    t.setEventHandler(handler: body)
    t.resume()
    audioTimers.append(t)
}

func audioInputDevices() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
}

func audioDevices() -> JSON {
    let def = AVCaptureDevice.default(for: .audio)?.uniqueID
    return ["devices": audioInputDevices().map { ["id": $0.uniqueID, "name": $0.localizedName, "default": $0.uniqueID == def] as JSON },
            "default": def as Any]
}

/// Microphone through AVCaptureSession. Never asks for permission: without it
/// the source exits 2 and the user grants it from the tray or the settings window.
func runMicrophone(device id: String?) -> Never {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
        audioFail("microphone_permission_missing", code: 2, permission: true)
    }
    let pinned = id.flatMap { want in audioInputDevices().first { $0.uniqueID == want } }
    guard let device = pinned ?? AVCaptureDevice.default(for: .audio) else {
        audioFail(id == nil ? "no_input_device" : "input_device_not_found", code: 1)
    }
    let session = AVCaptureSession()
    do {
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { audioFail("input_rejected", code: 1) }
        session.addInput(input)
    } catch {
        audioFail("input_failed: \(error.localizedDescription)", code: 1)
    }
    let output = AVCaptureAudioDataOutput()
    output.setSampleBufferDelegate(audioCapture, queue: audioQueue)
    guard session.canAddOutput(output) else { audioFail("output_rejected", code: 1) }
    session.addOutput(output)
    let center = NotificationCenter.default
    center.addObserver(forName: .AVCaptureDeviceWasDisconnected, object: device, queue: .main) { _ in
        audioEvent(["event": "device_changed", "device": device.localizedName]); exit(3)
    }
    center.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: .main) { n in
        let err = n.userInfo?[AVCaptureSessionErrorKey] as? Error
        audioFail("session_error: \(err?.localizedDescription ?? "unknown")", code: 1)
    }
    session.startRunning()
    guard session.isRunning else { audioFail("session_not_running", code: 1) }
    audioEvent(["event": "started", "source": "microphone", "device": device.localizedName])
    if id == nil || pinned == nil {
        // Follow the system default (headphones plugged in, a new default mic),
        // and go back to the chosen device once it is connected again.
        let current = device.uniqueID
        every(2) {
            let back = id.map { want in audioInputDevices().contains { $0.uniqueID == want } } ?? false
            if back || AVCaptureDevice.default(for: .audio)?.uniqueID != current {
                audioEvent(["event": "device_changed"]); exit(3)
            }
        }
    }
    dispatchMain()
}

/// What the computer plays, through ScreenCaptureKit. Excluded apps' audio is
/// filtered out; apps that start later are added to the filter within 5 s.
func runSystemAudio(exclude: [String]) -> Never {
    guard CGPreflightScreenCaptureAccess() else {
        audioFail("screen_recording_permission_missing", code: 2, permission: true)
    }
    let hidden = exclude + alwaysExcluded + ownBundleIds
    func filter(_ content: SCShareableContent) throws -> (SCContentFilter, Set<String>) {
        guard let display = content.displays.first else {
            throw NSError(domain: "engine", code: 3, userInfo: [NSLocalizedDescriptionKey: "no_display"])
        }
        let apps = content.applications.filter { appListed(hidden, appIds($0)) || isOwn($0.bundleIdentifier, []) }
        return (SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: []),
                Set(apps.map { $0.bundleIdentifier }))
    }
    let stream: SCStream
    var applied: Set<String>
    do {
        (stream, applied) = try blocking { () async throws -> (SCStream, Set<String>) in
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let (f, ids) = try filter(content)
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.excludesCurrentProcessAudio = true
            cfg.sampleRate = 16000
            cfg.channelCount = 1
            // Video is required by the API; keep it tiny and rare.
            cfg.width = 2
            cfg.height = 2
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            cfg.queueDepth = 3
            let stream = SCStream(filter: f, configuration: cfg, delegate: audioCapture)
            try stream.addStreamOutput(audioCapture, type: .audio, sampleHandlerQueue: audioQueue)
            try stream.addStreamOutput(audioCapture, type: .screen, sampleHandlerQueue: audioQueue)
            try await stream.startCapture()
            return (stream, ids)
        }
    } catch {
        audioFail("system_audio_failed: \(error.localizedDescription)", code: 1)
    }
    audioEvent(["event": "started", "source": "system", "device": "system audio"])
    every(5) {
        Task {
            guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
                  let (f, ids) = try? filter(content), ids != applied else { return }
            try? await stream.updateContentFilter(f)
            applied = ids
        }
    }
    dispatchMain()
}

/// Test seam: play a file once, in real time, through the same conversion and pipe.
func runFile(path: String) -> Never {
    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
        audioFail("file_unreadable", code: 1)
    }
    audioEvent(["event": "started", "source": "file", "device": URL(fileURLWithPath: path).lastPathComponent])
    let block = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
    let start = Date()
    var played = 0.0
    while let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: block) {
        do { try file.read(into: buf, frameCount: block) } catch { break }
        if buf.frameLength == 0 { break }
        played += Double(buf.frameLength) / file.processingFormat.sampleRate
        // Deliver each 100 ms block when its last sample would have been heard.
        let wait = start.addingTimeInterval(played).timeIntervalSinceNow
        if wait > 0 { Thread.sleep(forTimeInterval: wait) }
        audioCapture.pcm.write(buf)
    }
    exit(0)
}

func runAudioSource(_ args: [String]) -> Never {
    var opts: [String: String] = [:]
    var i = 0
    while i + 1 < args.count { opts[args[i]] = args[i + 1]; i += 2 }
    signal(SIGPIPE, SIG_DFL)
    switch opts["--source"] {
    case "microphone": runMicrophone(device: opts["--device"])
    case "system":
        runSystemAudio(exclude: (opts["--exclude"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty })
    case "file":
        guard let path = opts["--path"] else { audioFail("bad_request", code: 1) }
        runFile(path: path)
    default: audioFail("unknown_source", code: 1)
    }
}

/// Raw PCM (16 kHz mono s16le) -> AAC-LC in M4A. ExtAudioFile with the reserve
/// duration set keeps the header padding at ~3 KB (AVAudioFile reserves ~23 KB).
func encodeAudio(_ req: JSON) -> JSON {
    guard let input = req["input"] as? String, let out = req["out"] as? String,
          var pcm = FileManager.default.contents(atPath: input) else { return fail("bad_request") }
    let rate = req["sample_rate"] as? Double ?? 16000
    var bitrate = UInt32(req["bitrate"] as? Int ?? 32000)
    let frames = pcm.count / 2
    guard frames > 0 else { return fail("bad_request") }
    let url = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: url)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    var dst = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0, mBytesPerPacket: 0,
                                          mFramesPerPacket: 1024, mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
    var src = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                          mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
                                          mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
    var ext: ExtAudioFileRef?
    func check(_ status: OSStatus, _ step: String) throws {
        if status != noErr { throw NSError(domain: "engine", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "\(step) (\(status))"]) }
    }
    do {
        try check(ExtAudioFileCreateWithURL(url as CFURL, kAudioFileM4AType, &dst, nil, AudioFileFlags.eraseFile.rawValue, &ext), "create")
        defer { if let ext { ExtAudioFileDispose(ext) } }
        try check(ExtAudioFileSetProperty(ext!, kExtAudioFileProperty_ClientDataFormat, UInt32(MemoryLayout.size(ofValue: src)), &src), "client_format")
        var converter: AudioConverterRef?
        var size = UInt32(MemoryLayout<AudioConverterRef?>.size)
        try check(ExtAudioFileGetProperty(ext!, kExtAudioFileProperty_AudioConverter, &size, &converter), "converter")
        try check(AudioConverterSetProperty(converter!, kAudioConverterEncodeBitRate, 4, &bitrate), "bitrate")
        // A NULL converter config makes ExtAudioFile pick up the new bitrate.
        var config: UnsafeRawPointer? = nil
        try check(ExtAudioFileSetProperty(ext!, kExtAudioFileProperty_ConverterConfig, UInt32(MemoryLayout<UnsafeRawPointer?>.size), &config), "converter_config")
        var file: AudioFileID?
        size = UInt32(MemoryLayout<AudioFileID?>.size)
        try check(ExtAudioFileGetProperty(ext!, kExtAudioFileProperty_AudioFile, &size, &file), "audio_file")
        var duration = Float64(frames) / rate
        _ = AudioFileSetProperty(file!, kAudioFilePropertyReserveDuration, UInt32(MemoryLayout<Float64>.size), &duration)
        let bytes = pcm.count
        try pcm.withUnsafeMutableBytes { raw in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes), mData: raw.baseAddress))
            try check(ExtAudioFileWrite(ext!, UInt32(frames), &list), "write")
        }
    } catch {
        try? FileManager.default.removeItem(at: url)
        return fail("encode_audio_failed: \(error.localizedDescription)")
    }
    let size = (try? FileManager.default.attributesOfItem(atPath: out)[.size] as? Int) ?? 0
    guard size > 0 else { return fail("encode_audio_failed: empty output") }
    return ["path": out, "size_bytes": size, "duration_ms": frames * 1000 / Int(rate)]
}

/// On-device transcription. macOS 26: SpeechAnalyzer (no permission needed; the
/// language model downloads once unless `allow_download` is false). macOS 14-15:
/// SFSpeechRecognizer with on-device recognition, when Speech Recognition is allowed.
func transcribe(_ req: JSON) -> JSON {
    guard let path = req["path"] as? String else { return fail("bad_request") }
    let allowDownload = req["allow_download"] as? Bool ?? true
    let locale = (req["locale"] as? String).map { Locale(identifier: $0) } ?? Locale.current
    do {
        if #available(macOS 26.0, *) {
            return try blocking { () async throws -> JSON in
                guard SpeechTranscriber.isAvailable else { throw NSError(domain: "engine", code: 5, userInfo: [NSLocalizedDescriptionKey: "transcriber_unavailable"]) }
                let lang = await SpeechTranscriber.supportedLocale(equivalentTo: locale) ?? Locale(identifier: "en-US")
                let module = SpeechTranscriber(locale: lang, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
                if await AssetInventory.status(forModules: [module]) != .installed {
                    guard allowDownload else { throw NSError(domain: "engine", code: 6, userInfo: [NSLocalizedDescriptionKey: "speech_model_not_installed"]) }
                    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                        try await request.downloadAndInstall()
                    }
                }
                let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
                let analyzer = SpeechAnalyzer(modules: [module])
                let collect = Task { () -> [JSON] in
                    var out: [JSON] = []
                    for try await r in module.results {
                        out.append(["start_ms": Int(r.range.start.seconds * 1000), "end_ms": Int(r.range.end.seconds * 1000),
                                    "text": String(r.text.characters)])
                    }
                    return out
                }
                if let last = try await analyzer.analyzeSequence(from: file) {
                    try await analyzer.finalizeAndFinish(through: last)
                } else {
                    await analyzer.cancelAndFinishNow()
                }
                return ["segments": try await collect.value, "locale": lang.identifier, "engine": "speech_analyzer"]
            }
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else { return fail("speech_permission_missing") }
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
            return fail("on_device_recognition_unavailable")
        }
        let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
        request.requiresOnDeviceRecognition = true
        let sema = DispatchSemaphore(value: 0)
        var segments: [JSON] = []
        var failure: String?
        recognizer.recognitionTask(with: request) { result, error in
            if let error { failure = error.localizedDescription; sema.signal(); return }
            guard let result, result.isFinal else { return }
            segments = result.bestTranscription.segments.map {
                ["start_ms": Int($0.timestamp * 1000), "end_ms": Int(($0.timestamp + $0.duration) * 1000), "text": $0.substring]
            }
            sema.signal()
        }
        sema.wait()
        if let failure { return fail("transcribe_failed: \(failure)") }
        return ["segments": segments, "locale": locale.identifier, "engine": "sf_speech"]
    } catch {
        return fail("transcribe_failed: \(error.localizedDescription)")
    }
}

// MARK: - Main loop

// A background helper: no Dock icon and no app switcher entry. Without this, AppKit
// registers the process as a foreground app and the Dock shows it while recording.
NSApplication.shared.setActivationPolicy(.accessory)

if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "audio" {
    runAudioSource(Array(CommandLine.arguments.dropFirst(2)))
}

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
        case "request_permissions": res = requestPermissions(req)
        case "capture", "capture_private": res = capture(req)
        case "probe": res = probe(req)
        case "_plan_displays": res = planDisplaysCommand(req)
        case "_domain_match": res = domainMatchCommand(req)
        case "_app_match": res = appMatchCommand(req)
        case "ocr": res = ocr(req)
        case "icon": res = icon(req)
        case "encode": res = encode(req)
        case "extract": res = extract(req)
        case "convert": res = convert(req)
        case "transcode": res = transcode(req)
        case "encode_audio": res = encodeAudio(req)
        case "transcribe": res = transcribe(req)
        case "audio_devices": res = audioDevices()
        case "image_color":
            if let p = req["path"] as? String, let img = loadImage(p) { res = ["dominant_color": dominantColor(img), "width": img.width, "height": img.height] }
            else { res = fail("image_not_found") }
        default: res = fail("unknown_cmd: \(cmd)")
        }
        if let id = req["id"] { res["id"] = id }
        emit(res)
    }
}
