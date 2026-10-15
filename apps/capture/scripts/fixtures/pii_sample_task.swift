// Synthetic support task window for local recorder privacy verification.
// No real customer data, network, clipboard or account is used.
import AppKit

final class TaskWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
final class TaskDelegate: NSObject, NSApplicationDelegate {
    var window: TaskWindow!
    var state: NSTextField!
    var timer: Timer?
    let statePath = CommandLine.arguments.dropFirst().first
    func applicationDidFinishLaunching(_ notification: Notification) {
        let screen = NSScreen.main!
        let size = NSSize(width: min(1000, screen.frame.width - 80), height: min(720, screen.frame.height - 80))
        window = TaskWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Synthetic support — alice@example.com"
        window.backgroundColor = NSColor(calibratedRed: 0.94, green: 0.96, blue: 0.99, alpha: 1)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = NSView(frame: NSRect(origin: .zero, size: size))
        window.contentView = view
        let scale = min(size.width / 1440, size.height / 900)
        @discardableResult func label(_ text: String, _ x: CGFloat, _ top: CGFloat, _ size: CGFloat, _ width: CGFloat, mono: Bool = false) -> NSTextField {
            let field = NSTextField(labelWithString: text)
            field.frame = NSRect(x: x * scale, y: view.frame.height - (top + size + 12) * scale, width: width * scale, height: (size + 12) * scale)
            field.font = mono ? NSFont.monospacedSystemFont(ofSize: size * scale, weight: .medium) : NSFont.systemFont(ofSize: size * scale, weight: .medium)
            field.textColor = NSColor(calibratedRed: 0.09, green: 0.14, blue: 0.25, alpha: 1)
            field.setAccessibilityLabel(text)
            view.addSubview(field)
            return field
        }
        label("KORTIX  /  SYNTHETIC SUPPORT DESK", 64, 55, 20, 1300)
        label("Review a customer refund", 64, 100, 40, 1300)
        label("Order DEMO-2048  ·  Status: awaiting review  ·  Total: USD 42.00", 64, 165, 21, 1300)
        let rows = [
            ("Customer name", "Alice Example"),
            ("Shipping address", "42 Fictional Lane, Example City"),
            ("Email", "alice@example.com"),
            ("Test payment card", "4111 1111 1111 1111"),
            ("Synthetic SSN", "123-45-6789"),
            ("Test phone", "+1 555 010 0100"),
            ("Example IBAN", "GB82 WEST 1234 5698 7654 32"),
            ("Example AWS key", "AKIAIOSFODNN7EXAMPLE"),
            ("Example GitHub token", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ("Invalid card checksum", "4111 1111 1111 1112"),
        ]
        for (i, row) in rows.enumerated() {
            let top = CGFloat(230 + i * 47)
            label(row.0, 64, top, 21, 330)
            label(row.1, 445, top, 27, 940, mono: true)
        }
        state = label("Task step: review details", 64, 730, 24, 1300)
        label("Synthetic data only. The verifier closes this window when finished.", 64, 785, 18, 1300)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let path = statePath { try? "ready".write(toFile: path + ".ready", atomically: true, encoding: .utf8) }
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            guard let self, let path = self.statePath, let text = try? String(contentsOfFile: path, encoding: .utf8) else { return }
            self.state.stringValue = "Task step: " + text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}
let app = NSApplication.shared
let delegate = TaskDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
