#pragma once

#include <string>
#include <vector>
#include <tree_sitter/api.h>
#include "HybridEditorEngineSpec.hpp"

extern "C" TSLanguage *tree_sitter_javascript();

namespace margelo::nitro::editorengine {

class PieceTable;

class SyntaxEngine {
public:
    SyntaxEngine(const PieceTable* pieceTable);
    ~SyntaxEngine();

    void parseFull();

    void applyEditAndParse(
        size_t startByte,
        size_t oldEndByte,
        size_t newEndByte,
        const CursorPosition& startPos,
        const CursorPosition& oldEndPos,
        const CursorPosition& newEndPos
    );

    std::vector<SyntaxToken> getSyntaxTokens(int startLine, int endLine) const;

private:
    const PieceTable* pieceTable_;
    TSParser* parser_;
    TSTree* tree_;
    TSQuery* query_;

    static const char* readCallback(void* payload, uint32_t byte_index, TSPoint position, uint32_t* bytes_read);
};

} // namespace margelo::nitro::editorengine
