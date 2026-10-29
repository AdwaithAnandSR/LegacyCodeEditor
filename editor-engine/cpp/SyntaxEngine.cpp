#include "SyntaxEngine.hpp"
#include "HybridEditorEngine.hpp"
#include <iostream>
#include <cstring>
#include <algorithm>

namespace margelo::nitro::editorengine {

static int getCapturePriority(const std::string& type) {
    if (type == "keyword") return 6;
    if (type == "function") return 5;
    if (type == "property") return 4;
    if (type == "string") return 3;
    if (type == "number") return 2;
    if (type == "comment") return 1;
    return 0; // variable / default
}

SyntaxEngine::SyntaxEngine(const PieceTable* pieceTable) : pieceTable_(pieceTable) {
    parser_ = ts_parser_new();
    ts_parser_set_language(parser_, tree_sitter_javascript());
    tree_ = nullptr;
    query_ = nullptr;
    
        const char* query_source = R"(
        (identifier) @variable
        (string) @string
        (number) @number
        (comment) @comment
        (property_identifier) @property
        (function_declaration name: (identifier) @function)
        (call_expression function: (identifier) @function)
        
        "import" @keyword
        "export" @keyword
        "from" @keyword
        "class" @keyword
        "function" @keyword
        "const" @keyword
        "let" @keyword
        "var" @keyword
        "if" @keyword
        "else" @keyword
        "for" @keyword
        "while" @keyword
        "do" @keyword
        "switch" @keyword
        "case" @keyword
        "return" @keyword
        "break" @keyword
        "continue" @keyword
        "yield" @keyword
        "await" @keyword
        "async" @keyword
        "try" @keyword
        "catch" @keyword
        "finally" @keyword
        "throw" @keyword
        "new" @keyword
        "delete" @keyword
        "typeof" @keyword
        "instanceof" @keyword
        "in" @keyword
        "of" @keyword
        (true) @keyword
        (false) @keyword
        (null) @keyword
    )";
    uint32_t error_offset;
    TSQueryError error_type;
    query_ = ts_query_new(tree_sitter_javascript(), query_source, strlen(query_source), &error_offset, &error_type);
    
    if (!query_) {
        internalErrors_.push_back("TSQuery failed to compile. Error type: " + std::to_string(error_type) + " at offset: " + std::to_string(error_offset));
        // Fallback to a minimal safe query if the complex one fails due to version mismatch
        const char* safe_query = R"(
            (identifier) @variable
            (string) @string
            (number) @number
            (comment) @comment
        )";
        query_ = ts_query_new(tree_sitter_javascript(), safe_query, strlen(safe_query), &error_offset, &error_type);
        if (!query_) {
            internalErrors_.push_back("Safe TSQuery also failed. Error type: " + std::to_string(error_type));
        }
    }
}

SyntaxEngine::~SyntaxEngine() {
    if (query_) ts_query_delete(query_);
    if (tree_) ts_tree_delete(tree_);
    if (parser_) ts_parser_delete(parser_);
}

const char* SyntaxEngine::readCallback(void* payload, uint32_t byte_index, TSPoint /* position */, uint32_t* bytes_read) {
    const SyntaxEngine* engine = static_cast<const SyntaxEngine*>(payload);
    if (!engine || !engine->pieceTable_) {
        *bytes_read = 0;
        return "";
    }
    
    auto chunk = engine->pieceTable_->getChunkAtOffset(byte_index);
    if (!chunk.first) {
        *bytes_read = 0;
        return "";
    }
    
    *bytes_read = chunk.second;
    return chunk.first;
}

void SyntaxEngine::parseFull() {
    if (tree_) {
        ts_tree_delete(tree_);
        tree_ = nullptr;
    }
    
    TSInput input;
    input.payload = this;
    input.read = readCallback;
    input.encoding = TSInputEncodingUTF8;
    
    tree_ = ts_parser_parse(parser_, nullptr, input);
}

void SyntaxEngine::applyEditAndParse(
    size_t startByte,
    size_t oldEndByte,
    size_t newEndByte,
    const CursorPosition& startPos,
    const CursorPosition& oldEndPos,
    const CursorPosition& newEndPos
) {
    if (!tree_) {
        parseFull();
        return;
    }
    
    // In tree-sitter, TSPoint column is the BYTE offset from line start
    size_t startLineIdx = static_cast<size_t>(std::max(1.0, startPos.line)) - 1;
    size_t oldEndLineIdx = static_cast<size_t>(std::max(1.0, oldEndPos.line)) - 1;
    size_t newEndLineIdx = static_cast<size_t>(std::max(1.0, newEndPos.line)) - 1;

    size_t startLineStart = pieceTable_->getLineStartOffset(startLineIdx);
    size_t oldEndLineStart = pieceTable_->getLineStartOffset(oldEndLineIdx);
    size_t newEndLineStart = pieceTable_->getLineStartOffset(newEndLineIdx);

    TSInputEdit edit;
    edit.start_byte = startByte;
    edit.old_end_byte = oldEndByte;
    edit.new_end_byte = newEndByte;
    
    edit.start_point = {
        static_cast<uint32_t>(startLineIdx),
        static_cast<uint32_t>(startByte >= startLineStart ? startByte - startLineStart : 0)
    };
    edit.old_end_point = {
        static_cast<uint32_t>(oldEndLineIdx),
        static_cast<uint32_t>(oldEndByte >= oldEndLineStart ? oldEndByte - oldEndLineStart : 0)
    };
    edit.new_end_point = {
        static_cast<uint32_t>(newEndLineIdx),
        static_cast<uint32_t>(newEndByte >= newEndLineStart ? newEndByte - newEndLineStart : 0)
    };
    
    ts_tree_edit(tree_, &edit);
    
    TSInput input;
    input.payload = this;
    input.read = readCallback;
    input.encoding = TSInputEncodingUTF8;
    
    TSTree* new_tree = ts_parser_parse(parser_, tree_, input);
    ts_tree_delete(tree_);
    tree_ = new_tree;
}

std::vector<SyntaxToken> SyntaxEngine::getSyntaxTokens(int startLine, int endLine) const {
    std::vector<SyntaxToken> tokens;
    if (!tree_ || !query_ || !pieceTable_) return tokens;
    
    TSNode root_node = ts_tree_root_node(tree_);
    TSQueryCursor* cursor = ts_query_cursor_new();
    
    uint32_t minRow = static_cast<uint32_t>(std::max(0, startLine - 1));
    uint32_t maxRow = static_cast<uint32_t>(std::max(0, endLine - 1));

    TSPoint start_point = {minRow, 0};
    TSPoint end_point = {maxRow + 1, 0};
    ts_query_cursor_set_point_range(cursor, start_point, end_point);
    
    ts_query_cursor_exec(cursor, query_, root_node);
    
    struct RawToken {
        double line;
        double startCol;
        double endCol;
        std::string type;
        int priority;
    };
    std::vector<RawToken> rawTokens;

    TSQueryMatch match;
    while (ts_query_cursor_next_match(cursor, &match)) {
        for (uint16_t i = 0; i < match.capture_count; ++i) {
            const TSQueryCapture& capture = match.captures[i];
            TSNode node = capture.node;
            
            TSPoint start = ts_node_start_point(node);
            TSPoint end = ts_node_end_point(node);
            
            uint32_t name_len;
            const char* name = ts_query_capture_name_for_id(query_, capture.index, &name_len);
            std::string tokenType(name, name_len);
            int priority = getCapturePriority(tokenType);

            // Clamp rows to visible range (solves defect R5!)
            uint32_t rStart = std::max(start.row, minRow);
            uint32_t rEnd = std::min(end.row, maxRow);

            for (uint32_t r = rStart; r <= rEnd; ++r) {
                std::string lineStr = pieceTable_->getLine(r);
                double sCol = (r == start.row) 
                    ? static_cast<double>(utf8_util::byteOffsetToUtf16Column(lineStr, start.column)) 
                    : 0.0;
                double eCol = (r == end.row) 
                    ? static_cast<double>(utf8_util::byteOffsetToUtf16Column(lineStr, end.column)) 
                    : static_cast<double>(utf8_util::utf16Length(lineStr));
                
                if (eCol > sCol) {
                    rawTokens.push_back(RawToken{
                        static_cast<double>(r + 1),
                        sCol,
                        eCol,
                        tokenType,
                        priority
                    });
                }
            }
        }
    }
    
    ts_query_cursor_delete(cursor);

    // Sort tokens by (line, startCol, -priority, -(endCol - startCol))
    std::stable_sort(rawTokens.begin(), rawTokens.end(), [](const RawToken& a, const RawToken& b) {
        if (a.line != b.line) return a.line < b.line;
        if (a.startCol != b.startCol) return a.startCol < b.startCol;
        if (a.priority != b.priority) return a.priority > b.priority;
        return (a.endCol - a.startCol) > (b.endCol - b.startCol);
    });

    // Deduplicate overlapping captures on the same line (solves Bug 12)
    tokens.reserve(rawTokens.size());
    double currentLine = -1;
    double lastEndCol = -1;

    for (const auto& rt : rawTokens) {
        if (rt.line != currentLine) {
            currentLine = rt.line;
            lastEndCol = -1;
        }
        if (rt.startCol >= lastEndCol) {
            tokens.push_back(SyntaxToken(rt.line, rt.startCol, rt.endCol, rt.type));
            lastEndCol = rt.endCol;
        }
    }

    return tokens;
}

} // namespace margelo::nitro::editorengine
