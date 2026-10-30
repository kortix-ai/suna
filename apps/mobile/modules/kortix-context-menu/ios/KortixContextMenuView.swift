import ExpoModulesCore
import UIKit

/// A plain container for React Native children with the system context menu
/// (`UIContextMenuInteraction`). React Native lays the children out as usual;
/// a long press lifts this view as the preview, blurs the rest, and opens a
/// `UIMenu` (Liquid Glass on iOS 26).
final class KortixContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onPressAction = EventDispatcher()

  var menuTitle = ""
  var actions: [ContextMenuAction] = []
  var previewCornerRadius: CGFloat = 0

  private var interaction: UIContextMenuInteraction?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    setEnabled(true)
  }

  func setEnabled(_ enabled: Bool) {
    if enabled, interaction == nil {
      let added = UIContextMenuInteraction(delegate: self)
      addInteraction(added)
      interaction = added
    } else if !enabled, let current = interaction {
      removeInteraction(current)
      interaction = nil
    }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard !actions.isEmpty else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      let items = self.actions.map { action in
        UIAction(
          title: action.title,
          image: action.systemImage.flatMap { UIImage(systemName: $0) }
        ) { [weak self] _ in
          self?.onPressAction(["id": action.id])
        }
      }
      return UIMenu(title: self.menuTitle, children: items)
    }
  }

  // The lifted preview is this view, clipped to the bubble's corners.
  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configuration: UIContextMenuConfiguration,
    highlightPreviewForItemWithIdentifier identifier: NSCopying
  ) -> UITargetedPreview? {
    targetedPreview()
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configuration: UIContextMenuConfiguration,
    dismissalPreviewForItemWithIdentifier identifier: NSCopying
  ) -> UITargetedPreview? {
    targetedPreview()
  }

  private func targetedPreview() -> UITargetedPreview? {
    guard window != nil else { return nil }
    let parameters = UIPreviewParameters()
    parameters.backgroundColor = .clear
    parameters.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: previewCornerRadius)
    return UITargetedPreview(view: self, parameters: parameters)
  }
}
