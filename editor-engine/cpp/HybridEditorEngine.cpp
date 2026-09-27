#include "HybridEditorEngine.hpp"
#include <NitroModules/HybridObjectRegistry.hpp>
#include <memory>

namespace margelo::nitro::editorengine {

  void registerEditorEngine() {
    margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
      "EditorEngine",
      []() -> std::shared_ptr<margelo::nitro::HybridObject> {
        return std::make_shared<HybridEditorEngine>();
      }
    );
  }

  // Register on library load
  static const int autoRegister = []() {
    registerEditorEngine();
    return 0;
  }();

}
