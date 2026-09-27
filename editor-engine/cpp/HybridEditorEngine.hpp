#pragma once

#include "HybridEditorEngineSpec.hpp"
#include <string>
#include <vector>

enum class BufferSource { ORIGINAL, ADD };

struct Piece {
    BufferSource source;
    size_t start;
    size_t length;
};

class PieceTable {
private:
    std::string originalBuffer;
    std::string addBuffer;
    std::vector<Piece> pieces;

public:
    PieceTable() {
        originalBuffer = "";
    }

    void insert(size_t index, const std::string& text) {
        size_t startIdx = addBuffer.length();
        addBuffer += text;
        pieces.push_back({BufferSource::ADD, startIdx, text.length()});
    }

    std::string getText() {
        std::string result;
        for (const auto& piece : pieces) {
            if (piece.source == BufferSource::ORIGINAL) {
                result += originalBuffer.substr(piece.start, piece.length);
            } else {
                result += addBuffer.substr(piece.start, piece.length);
            }
        }
        return result;
    }
};

namespace margelo::nitro::editorengine {

class HybridEditorEngine : public HybridEditorEngineSpec {
private:
    PieceTable pieceTable;

public:
    HybridEditorEngine() : HybridObject(TAG) {}

    void insertText(double index, const std::string& text) override {
        pieceTable.insert(static_cast<size_t>(index), text);
    }

    std::string getText() override {
        return pieceTable.getText();
    }
};

} // namespace margelo::nitro::editorengine