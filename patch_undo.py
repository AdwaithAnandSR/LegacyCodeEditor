with open('editor-engine/cpp/HybridEditorEngine.hpp', 'r') as f:
    content = f.read()

undo_old = """    void undo() override {
        auto content = undoManager_.undo(pieceTable_.getText());
        if (content.has_value()) {
            pieceTable_.loadContent(content.value());
            // Check if we're back to saved state
            if (computeHash(content.value()) == savedContentHash_) {
                modified_ = false;
            }
        }
    }"""

undo_new = """    void undo() override {
        auto content = undoManager_.undo(pieceTable_.getText());
        if (content.has_value()) {
            pieceTable_.loadContent(content.value());
            // Check if we're back to saved state
            if (computeHash(content.value()) == savedContentHash_) {
                modified_ = false;
            }
            if (syntaxEngine_) syntaxEngine_->parseFull();
        }
    }"""

content = content.replace(undo_old, undo_new)

with open('editor-engine/cpp/HybridEditorEngine.hpp', 'w') as f:
    f.write(content)
