import ExpoModulesCore

public class PocketTerminalModule: Module {
  // Each module class must implement the definition function. The definition consists of components
  // that describes the module's functionality and behavior.
  // See https://docs.expo.dev/modules/module-api for more details about available components.
  public func definition() -> ModuleDefinition {
    // Sets the name of the module that JavaScript code will use to refer to the module. Takes a string as an argument.
    // Can be inferred from module's class name, but it's recommended to set it explicitly for clarity.
    // The module will be accessible from `requireNativeModule('PocketTerminalModule')` in JavaScript.
    Name("PocketTerminalModule")

    // Defines constant property on the module.
    Constant("PI") {
      Double.pi
    }

    // Defines event names that the module can send to JavaScript.
    Events("onChange")

    // Defines a JavaScript synchronous function that runs the native code on the JavaScript thread.
    Function("hello") {
      return "Hello world! 👋"
    }

    AsyncFunction("resolveWorkspacePath") {
      (rootPath: String, relativePath: String, allowMissing: Bool) -> String in
      let root = URL(fileURLWithPath: rootPath)
        .resolvingSymlinksInPath()
        .standardizedFileURL
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
            isDirectory.boolValue else {
        throw NSError(
          domain: "PocketTerminalModule",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Workspace root is unavailable"]
        )
      }
      let target = root
        .appendingPathComponent(relativePath)
        .resolvingSymlinksInPath()
        .standardizedFileURL
      let rootComponents = root.pathComponents
      let targetComponents = target.pathComponents
      guard targetComponents.count >= rootComponents.count,
            Array(targetComponents.prefix(rootComponents.count)) == rootComponents else {
        throw NSError(
          domain: "PocketTerminalModule",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Workspace path resolves outside the workspace"]
        )
      }
      if !allowMissing && !FileManager.default.fileExists(atPath: target.path) {
        throw NSError(
          domain: "PocketTerminalModule",
          code: 3,
          userInfo: [NSLocalizedDescriptionKey: "Workspace path does not exist"]
        )
      }
      return target.path
    }

    // Defines a JavaScript function that always returns a Promise and whose native code
    // is by default dispatched on the different thread than the JavaScript runtime runs on.
    AsyncFunction("setValueAsync") { (value: String) in
      // Send an event to JavaScript.
      self.sendEvent("onChange", [
        "value": value
      ])
    }

    // Enables the module to be used as a native view. Definition components that are accepted as part of the
    // view definition: Prop, Events.
    View(PocketTerminalModuleView.self) {
      // Defines a setter for the `url` prop.
      Prop("url") { (view: PocketTerminalModuleView, url: URL) in
        if view.webView.url != url {
          view.webView.load(URLRequest(url: url))
        }
      }

      Events("onLoad")
    }
  }
}
