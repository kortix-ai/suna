import ExpoModulesCore

/// One menu row: `id` comes back in `onPressAction`.
struct ContextMenuAction: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  /// An SF Symbol name.
  @Field var systemImage: String?
}

public final class KortixContextMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KortixContextMenu")

    View(KortixContextMenuView.self) {
      Events("onPressAction")

      Prop("menuTitle") { (view, title: String?) in
        view.menuTitle = title ?? ""
      }

      Prop("actions") { (view, actions: [ContextMenuAction]) in
        view.actions = actions
      }

      Prop("previewCornerRadius") { (view, radius: Double?) in
        view.previewCornerRadius = CGFloat(radius ?? 0)
      }

      Prop("enabled") { (view, enabled: Bool?) in
        view.setEnabled(enabled ?? true)
      }
    }
  }
}
