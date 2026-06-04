import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HELPER_VERSION = 'v4';
const BIN_DIR = join(homedir(), '.agent-tunnel', 'bin');
const HELPER_PATH = join(BIN_DIR, `desktop-helper-${HELPER_VERSION}`);

const SWIFT_SOURCE = `
import Foundation
import CoreGraphics

struct Request: Decodable {
    let action: String
    let x: Double?
    let y: Double?
    let toX: Double?
    let toY: Double?
    let button: String?
    let clicks: Int?
    let modifiers: [String]?
    let deltaX: Int?
    let deltaY: Int?
    let keys: [String]?
    let pid: Int?
    let maxDepth: Int?
    let roles: [String]?
    let elementId: String?
    let action_name: String?
    let query: String?
    let role: String?
    let maxResults: Int?
    let value: String?
}

struct Response: Encodable {
    let ok: Bool
    let x: Double?
    let y: Double?
    let error: String?
    let elements: String?
    let elementCount: Int?
}

// ─── AX Helpers ──────────────────────────────────────────────
import ApplicationServices

var axElementCount = 0

func esc(_ s: String) -> String {
    return s.replacingOccurrences(of: "\\\\", with: "\\\\\\\\")
            .replacingOccurrences(of: "\\"", with: "\\\\\\"")
            .replacingOccurrences(of: "\\n", with: "\\\\n")
            .replacingOccurrences(of: "\\r", with: "\\\\r")
            .replacingOccurrences(of: "\\t", with: "\\\\t")
}

func axStr(_ element: AXUIElement, _ attr: String) -> String {
    var ref: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &ref)
    if err != .success { return "" }
    if let s = ref as? String { return s }
    if let n = ref as? NSNumber { return n.stringValue }
    if ref != nil { return "\\(ref!)" }
    return ""
}

struct AXProps {
    var role: String
    var subrole: String
    var title: String
    var value: String
    var description: String
    var label: String
    var roleDescription: String
    var placeholder: String
    var identifier: String
    var help: String
    var bounds: (x: Int, y: Int, w: Int, h: Int)
    var enabled: Bool
    var focused: Bool
    var actions: [String]
    var children: [AXUIElement]

    // All searchable text combined
    var searchText: String {
        return [title, value, description, label, roleDescription, placeholder, identifier, help]
            .joined(separator: " ")
            .lowercased()
    }

    // Best display label
    var displayLabel: String {
        if !title.isEmpty { return title }
        if !label.isEmpty { return label }
        if !value.isEmpty {
            let v = value.count > 60 ? String(value.prefix(60)) + "…" : value
            return v
        }
        if !description.isEmpty { return description }
        if !roleDescription.isEmpty { return roleDescription }
        if !placeholder.isEmpty { return "[\\(placeholder)]" }
        if !help.isEmpty { return help }
        return "(unnamed)"
    }

    func toJson(id: String) -> String {
        var json = "{"
        json += "\\"id\\":\\"\\(esc(id))\\""
        json += ",\\"role\\":\\"\\(esc(role))\\""
        if !subrole.isEmpty { json += ",\\"subrole\\":\\"\\(esc(subrole))\\"" }
        json += ",\\"title\\":\\"\\(esc(displayLabel))\\""
        json += ",\\"value\\":\\"\\(esc(value))\\""
        json += ",\\"description\\":\\"\\(esc(description))\\""
        if !label.isEmpty { json += ",\\"label\\":\\"\\(esc(label))\\"" }
        if !placeholder.isEmpty { json += ",\\"placeholder\\":\\"\\(esc(placeholder))\\"" }
        if !identifier.isEmpty { json += ",\\"identifier\\":\\"\\(esc(identifier))\\"" }
        json += ",\\"bounds\\":{\\"x\\":\\(bounds.x),\\"y\\":\\(bounds.y),\\"width\\":\\(bounds.w),\\"height\\":\\(bounds.h)}"
        json += ",\\"enabled\\":\\(enabled)"
        json += ",\\"focused\\":\\(focused)"
        json += ",\\"actions\\":["
        json += actions.map { "\\"\\(esc($0))\\"" }.joined(separator: ",")
        json += "]"
        return json
    }
}

func readAXProps(_ element: AXUIElement) -> AXProps {
    let role = axStr(element, kAXRoleAttribute as String)
    let subrole = axStr(element, kAXSubroleAttribute as String)
    let title = axStr(element, kAXTitleAttribute as String)
    let description = axStr(element, kAXDescriptionAttribute as String)
    let label = axStr(element, "AXLabel")
    let roleDescription = axStr(element, kAXRoleDescriptionAttribute as String)
    let placeholder = axStr(element, kAXPlaceholderValueAttribute as String)
    let identifier = axStr(element, "AXIdentifier")
    let help = axStr(element, kAXHelpAttribute as String)

    // Value: read carefully, handle different types
    var valueStr = ""
    var valueRef: AnyObject?
    let valErr = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef)
    if valErr == .success, let v = valueRef {
        if let s = v as? String { valueStr = s }
        else if let n = v as? NSNumber { valueStr = n.stringValue }
        else { valueStr = "\\(v)" }
    }

    // Bounds
    var posPoint = CGPoint.zero
    var posRef: AnyObject?
    if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success, let p = posRef {
        AXValueGetValue(p as! AXValue, .cgPoint, &posPoint)
    }
    var sizVal = CGSize.zero
    var sizRef: AnyObject?
    if AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizRef) == .success, let s = sizRef {
        AXValueGetValue(s as! AXValue, .cgSize, &sizVal)
    }

    // States
    var en: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &en)
    let enabled = (en as? Bool) ?? true
    var foc: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &foc)
    let focused = (foc as? Bool) ?? false

    // Actions
    var actionsArray: CFArray?
    AXUIElementCopyActionNames(element, &actionsArray)
    let actions = (actionsArray as? [String]) ?? []

    // Children
    var childrenRef: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef)
    let children = (childrenRef as? [AXUIElement]) ?? []

    return AXProps(
        role: role, subrole: subrole, title: title, value: valueStr,
        description: description, label: label, roleDescription: roleDescription,
        placeholder: placeholder, identifier: identifier, help: help,
        bounds: (Int(posPoint.x), Int(posPoint.y), Int(sizVal.width), Int(sizVal.height)),
        enabled: enabled, focused: focused, actions: actions, children: children
    )
}

func axTreeToJson(_ element: AXUIElement, depth: Int, maxDepth: Int, roles: [String]?, pathPrefix: String) -> String? {
    if depth > maxDepth { return nil }
    axElementCount += 1

    let p = readAXProps(element)

    // If role filter active and this element doesn't match, skip but walk children
    if let r = roles, !r.isEmpty, !r.contains(p.role.lowercased()) {
        var childJsons: [String] = []
        for (i, child) in p.children.enumerated() {
            let childPath = pathPrefix.isEmpty ? "\\(i)" : "\\(pathPrefix).\\(i)"
            if let cj = axTreeToJson(child, depth: depth, maxDepth: maxDepth, roles: roles, pathPrefix: childPath) {
                childJsons.append(cj)
            }
        }
        return childJsons.isEmpty ? nil : childJsons.joined(separator: ",")
    }

    var json = p.toJson(id: pathPrefix)

    json += ",\\"children\\":["
    if depth < maxDepth {
        var childJsons: [String] = []
        for (i, child) in p.children.enumerated() {
            let childPath = pathPrefix.isEmpty ? "\\(i)" : "\\(pathPrefix).\\(i)"
            if let cj = axTreeToJson(child, depth: depth + 1, maxDepth: maxDepth, roles: roles, pathPrefix: childPath) {
                childJsons.append(cj)
            }
        }
        json += childJsons.joined(separator: ",")
    }
    json += "]}"
    return json
}

func navigateToElement(_ root: AXUIElement, path: String) -> AXUIElement? {
    let parts = path.split(separator: ".").compactMap { Int($0) }
    var current = root
    for idx in parts {
        var childrenRef: AnyObject?
        AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &childrenRef)
        guard let children = childrenRef as? [AXUIElement], idx < children.count else { return nil }
        current = children[idx]
    }
    return current
}

func resolveAppElement(_ pid: Int) -> AXUIElement {
    if pid > 0 {
        return AXUIElementCreateApplication(pid_t(pid))
    }
    // pid=0: get the focused (frontmost) application
    let systemWide = AXUIElementCreateSystemWide()
    var focusedApp: AnyObject?
    let err = AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute as CFString, &focusedApp)
    if err == .success, let app = focusedApp {
        return (app as! AXUIElement)
    }
    // fallback to system-wide (limited)
    return systemWide
}

func searchAXTree(_ element: AXUIElement, query: String, roleFilter: String?, maxResults: Int, results: inout [String], pathPrefix: String, depth: Int, maxDepth: Int) {
    if results.count >= maxResults || depth > maxDepth { return }

    let p = readAXProps(element)
    let q = query.lowercased()

    // Search across ALL text attributes
    var match = p.searchText.contains(q)

    if let rf = roleFilter, !rf.isEmpty, p.role.lowercased() != rf.lowercased() {
        match = false
    }

    if match {
        results.append(p.toJson(id: pathPrefix) + ",\\"children\\":[]}")
    }

    // Walk children
    for (i, child) in p.children.enumerated() {
        if results.count >= maxResults { break }
        let childPath = pathPrefix.isEmpty ? "\\(i)" : "\\(pathPrefix).\\(i)"
        searchAXTree(child, query: query, roleFilter: roleFilter, maxResults: maxResults, results: &results, pathPrefix: childPath, depth: depth + 1, maxDepth: maxDepth)
    }
}

func modifierFlags(_ names: [String]) -> CGEventFlags {
    var flags = CGEventFlags()
    for name in names {
        switch name.lowercased() {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

let keyMap: [String: UInt16] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
    "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
    "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
    "6": 22, "7": 26, "8": 28, "9": 25,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\\\": 42, ";": 41,
    "'": 39, ",": 43, ".": 47, "/": 44, "\`": 50,
]

func mouseButton(_ name: String?) -> CGMouseButton {
    switch name?.lowercased() {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

func mouseDownType(_ btn: CGMouseButton) -> CGEventType {
    switch btn {
    case .right: return .rightMouseDown
    case .center: return .otherMouseDown
    default: return .leftMouseDown
    }
}

func mouseUpType(_ btn: CGMouseButton) -> CGEventType {
    switch btn {
    case .right: return .rightMouseUp
    case .center: return .otherMouseUp
    default: return .leftMouseUp
    }
}

func mouseDragType(_ btn: CGMouseButton) -> CGEventType {
    switch btn {
    case .right: return .rightMouseDragged
    case .center: return .otherMouseDragged
    default: return .leftMouseDragged
    }
}

func respond(_ r: Response) {
    let data = try! JSONEncoder().encode(r)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\\n".data(using: .utf8)!)
}

func handleRequest(_ req: Request) {
    switch req.action {
    case "click":
        let point = CGPoint(x: req.x ?? 0, y: req.y ?? 0)
        let btn = mouseButton(req.button)
        let clicks = req.clicks ?? 1
        let mods = modifierFlags(req.modifiers ?? [])

        for i in 0..<clicks {
            if let down = CGEvent(mouseEventSource: nil, mouseType: mouseDownType(btn), mouseCursorPosition: point, mouseButton: btn) {
                down.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
                if !mods.isEmpty { down.flags = mods }
                down.post(tap: .cghidEventTap)
            }
            if let up = CGEvent(mouseEventSource: nil, mouseType: mouseUpType(btn), mouseCursorPosition: point, mouseButton: btn) {
                up.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
                if !mods.isEmpty { up.flags = mods }
                up.post(tap: .cghidEventTap)
            }
        }
        respond(Response(ok: true, x: nil, y: nil, error: nil, elements: nil, elementCount: nil))

    case "move":
        let point = CGPoint(x: req.x ?? 0, y: req.y ?? 0)
        if let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            event.post(tap: .cghidEventTap)
        }
        respond(Response(ok: true, x: nil, y: nil, error: nil, elements: nil, elementCount: nil))

    case "drag":
        let from = CGPoint(x: req.x ?? 0, y: req.y ?? 0)
        let to = CGPoint(x: req.toX ?? 0, y: req.toY ?? 0)
        let btn = mouseButton(req.button)

        if let down = CGEvent(mouseEventSource: nil, mouseType: mouseDownType(btn), mouseCursorPosition: from, mouseButton: btn) {
            down.post(tap: .cghidEventTap)
        }
        usleep(50000)

        let steps = 10
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let mid = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            if let drag = CGEvent(mouseEventSource: nil, mouseType: mouseDragType(btn), mouseCursorPosition: mid, mouseButton: btn) {
                drag.post(tap: .cghidEventTap)
            }
            usleep(10000)
        }

        if let up = CGEvent(mouseEventSource: nil, mouseType: mouseUpType(btn), mouseCursorPosition: to, mouseButton: btn) {
            up.post(tap: .cghidEventTap)
        }
        respond(Response(ok: true, x: nil, y: nil, error: nil, elements: nil, elementCount: nil))

    case "scroll":
        let point = CGPoint(x: req.x ?? 0, y: req.y ?? 0)
        if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            move.post(tap: .cghidEventTap)
        }
        usleep(10000)

        let dy = Int32(req.deltaY ?? 0)
        let dx = Int32(req.deltaX ?? 0)
        if let scroll = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 3, wheel1: dy, wheel2: dx, wheel3: 0) {
            scroll.post(tap: .cghidEventTap)
        }
        respond(Response(ok: true, x: nil, y: nil, error: nil, elements: nil, elementCount: nil))

    case "key":
        let keys = req.keys ?? []
        var mods: [String] = []
        var mainKeys: [String] = []

        for k in keys {
            let lower = k.lowercased()
            if ["cmd", "command", "shift", "alt", "option", "ctrl", "control", "fn"].contains(lower) {
                mods.append(lower)
            } else {
                mainKeys.append(lower)
            }
        }

        let flags = modifierFlags(mods)

        for key in mainKeys {
            guard let code = keyMap[key] else {
                respond(Response(ok: false, x: nil, y: nil, error: "Unknown key: \\(key)", elements: nil, elementCount: nil))
                return
            }
            if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
                if !flags.isEmpty { down.flags = flags }
                down.post(tap: .cghidEventTap)
            }
            if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
                if !flags.isEmpty { up.flags = flags }
                up.post(tap: .cghidEventTap)
            }
        }
        respond(Response(ok: true, x: nil, y: nil, error: nil, elements: nil, elementCount: nil))

    case "position":
        let loc = CGEvent(source: nil)!.location
        respond(Response(ok: true, x: Double(loc.x), y: Double(loc.y), error: nil, elements: nil, elementCount: nil))

    case "ax_tree":
        let pid = req.pid ?? 0
        let maxD = req.maxDepth ?? 8
        let rolesFilter = req.roles?.map { $0.lowercased() }

        let appElement = resolveAppElement(pid)

        axElementCount = 0
        let treeJson = axTreeToJson(appElement, depth: 0, maxDepth: maxD, roles: rolesFilter, pathPrefix: "0") ?? "null"
        let treeOut = "{\\"ok\\":true,\\"root\\":" + treeJson + ",\\"elementCount\\":" + "\\(axElementCount)" + "}"
        FileHandle.standardOutput.write(treeOut.data(using: .utf8)!)
        FileHandle.standardOutput.write("\\n".data(using: .utf8)!)

    case "ax_action":
        let pid = req.pid ?? 0
        let elementId = req.elementId ?? "0"
        let actionName = req.action_name ?? ""

        let appElement = resolveAppElement(pid)

        guard let target = navigateToElement(appElement, path: elementId) else {
            respond(Response(ok: false, x: nil, y: nil, error: "Element not found: \\(elementId)", elements: nil, elementCount: nil))
            return
        }

        // Read state BEFORE action
        let beforeProps = readAXProps(target)
        let beforeFocused = beforeProps.focused
        let beforeValue = beforeProps.value

        let result = AXUIElementPerformAction(target, actionName as CFString)
        if result != .success {
            respond(Response(ok: false, x: nil, y: nil, error: "Action failed: \\(actionName) (error \\(result.rawValue))", elements: nil, elementCount: nil))
            return
        }

        // Brief pause for state to settle
        usleep(50000)

        // Read state AFTER action for verification
        let afterProps = readAXProps(target)
        var verifyJson = "{\\"ok\\":true"
        verifyJson += ",\\"action\\":\\"\\(esc(actionName))\\""
        verifyJson += ",\\"elementId\\":\\"\\(esc(elementId))\\""
        verifyJson += ",\\"before\\":{\\"focused\\":\\(beforeFocused),\\"value\\":\\"\\(esc(beforeValue))\\"}"
        verifyJson += ",\\"after\\":{\\"focused\\":\\(afterProps.focused),\\"value\\":\\"\\(esc(afterProps.value))\\"}"
        verifyJson += ",\\"role\\":\\"\\(esc(afterProps.role))\\""
        verifyJson += ",\\"title\\":\\"\\(esc(afterProps.displayLabel))\\""
        let changed = (beforeFocused != afterProps.focused) || (beforeValue != afterProps.value)
        verifyJson += ",\\"stateChanged\\":\\(changed)"
        verifyJson += "}"
        FileHandle.standardOutput.write(verifyJson.data(using: .utf8)!)
        FileHandle.standardOutput.write("\\n".data(using: .utf8)!)

    case "ax_set_value":
        let pid = req.pid ?? 0
        let elementId = req.elementId ?? "0"
        let newValue = req.value ?? ""

        let appElement = resolveAppElement(pid)

        guard let target = navigateToElement(appElement, path: elementId) else {
            respond(Response(ok: false, x: nil, y: nil, error: "Element not found: \\(elementId)", elements: nil, elementCount: nil))
            return
        }

        // First focus the element
        AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(30000)

        // Set the value directly
        let setResult = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, newValue as CFTypeRef)
        usleep(50000)

        // Verify by reading back
        let verifyValue = axStr(target, kAXValueAttribute as String)
        let success = (setResult == .success) && (verifyValue == newValue || verifyValue.contains(newValue))

        var svJson = "{\\"ok\\":\\(success)"
        svJson += ",\\"elementId\\":\\"\\(esc(elementId))\\""
        svJson += ",\\"requestedValue\\":\\"\\(esc(newValue))\\""
        svJson += ",\\"actualValue\\":\\"\\(esc(verifyValue))\\""
        if !success {
            if setResult != .success {
                svJson += ",\\"error\\":\\"SetAttributeValue failed (error \\(setResult.rawValue)). Element may not support direct value setting.\\""
            } else {
                svJson += ",\\"error\\":\\"Value was set but verification failed. Expected \\\\\\"\\"  + esc(newValue) + \\"\\\\\\", got \\\\\\"\\"+  esc(verifyValue) + \\"\\\\\\"\\""
            }
        }
        svJson += "}"
        FileHandle.standardOutput.write(svJson.data(using: .utf8)!)
        FileHandle.standardOutput.write("\\n".data(using: .utf8)!)

    case "ax_focus":
        let pid = req.pid ?? 0
        let elementId = req.elementId ?? "0"

        let appElement = resolveAppElement(pid)

        guard let target = navigateToElement(appElement, path: elementId) else {
            respond(Response(ok: false, x: nil, y: nil, error: "Element not found: \\(elementId)", elements: nil, elementCount: nil))
            return
        }

        // Read focus state before
        let beforeFocProps = readAXProps(target)

        // Set focused attribute
        let focResult = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(50000)

        // Verify focus
        let afterFocProps = readAXProps(target)
        let focSuccess = afterFocProps.focused

        var focJson = "{\\"ok\\":\\(focSuccess)"
        focJson += ",\\"elementId\\":\\"\\(esc(elementId))\\""
        focJson += ",\\"role\\":\\"\\(esc(afterFocProps.role))\\""
        focJson += ",\\"title\\":\\"\\(esc(afterFocProps.displayLabel))\\""
        focJson += ",\\"before\\":{\\"focused\\":\\(beforeFocProps.focused)}"
        focJson += ",\\"after\\":{\\"focused\\":\\(afterFocProps.focused)}"
        if !focSuccess {
            if focResult != .success {
                focJson += ",\\"error\\":\\"SetAttributeValue(kAXFocusedAttribute) failed (error \\(focResult.rawValue))\\""
            } else {
                focJson += ",\\"error\\":\\"Focus was requested but element reports not focused. It may not be focusable.\\""
            }
        }
        focJson += "}"
        FileHandle.standardOutput.write(focJson.data(using: .utf8)!)
        FileHandle.standardOutput.write("\\n".data(using: .utf8)!)

    case "ax_search":
        let pid = req.pid ?? 0
        let query = req.query ?? ""
        let roleFilter = req.role
        let maxRes = req.maxResults ?? 20

        let appElement = resolveAppElement(pid)

        var searchResults: [String] = []
        searchAXTree(appElement, query: query, roleFilter: roleFilter, maxResults: maxRes, results: &searchResults, pathPrefix: "0", depth: 0, maxDepth: 20)

        let searchOut = "{\\"ok\\":true,\\"elements\\":[" + searchResults.joined(separator: ",") + "]}"
        FileHandle.standardOutput.write(searchOut.data(using: .utf8)!)
        FileHandle.standardOutput.write("\\n".data(using: .utf8)!)

    default:
        respond(Response(ok: false, x: nil, y: nil, error: "Unknown action: \\(req.action)", elements: nil, elementCount: nil))
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = try? JSONDecoder().decode(Request.self, from: input) else {
    respond(Response(ok: false, x: nil, y: nil, error: "Invalid JSON input", elements: nil, elementCount: nil))
    exit(1)
}
handleRequest(req)
`;

let compiled = false;

export async function ensureHelper(): Promise<string> {
  if (compiled && existsSync(HELPER_PATH)) return HELPER_PATH;

  if (existsSync(HELPER_PATH)) {
    compiled = true;
    return HELPER_PATH;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  const srcPath = join(BIN_DIR, `desktop-helper-${HELPER_VERSION}.swift`);
  writeFileSync(srcPath, SWIFT_SOURCE);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('swiftc', ['-O', '-o', HELPER_PATH, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        chmodSync(HELPER_PATH, 0o755);
        compiled = true;
        resolve();
      } else {
        reject(new Error(`swiftc failed (exit ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`swiftc not found: ${err.message}. Install Xcode CLI tools: xcode-select --install`));
    });
  });

  return HELPER_PATH;
}

export interface HelperRequest {
  action: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  button?: string;
  clicks?: number;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
  keys?: string[];
  pid?: number;
  maxDepth?: number;
  roles?: string[];
  elementId?: string;
  action_name?: string;
  query?: string;
  role?: string;
  maxResults?: number;
  value?: string;
}

export interface HelperResponse {
  ok: boolean;
  x?: number;
  y?: number;
  error?: string;
  elements?: any[];
  elementCount?: number;
  root?: any;
  // Verification fields for ax_action/ax_set_value/ax_focus
  before?: { focused?: boolean; value?: string };
  after?: { focused?: boolean; value?: string };
  stateChanged?: boolean;
  action?: string;
  requestedValue?: string;
  actualValue?: string;
  role?: string;
  title?: string;
}

export async function execHelper(request: HelperRequest): Promise<HelperResponse> {
  const helperPath = await ensureHelper();

  return new Promise((resolve, reject) => {
    const proc = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        if (stderr.includes('accessibility') || stderr.includes('kAXError')) {
          reject(new Error(
            'Accessibility permission required. Open System Settings → Privacy & Security → Accessibility → Enable your terminal app.'
          ));
          return;
        }
        reject(new Error(`Helper failed (exit ${code}): ${stderr}`));
        return;
      }

      try {
        const response = JSON.parse(stdout.trim()) as HelperResponse;
        if (!response.ok && response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      } catch {
        reject(new Error(`Invalid helper output: ${stdout}`));
      }
    });

    proc.on('error', reject);

    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}
