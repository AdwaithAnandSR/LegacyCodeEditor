#include "SyntaxEngine.hpp"
#include "HybridEditorEngine.hpp"
#include <iostream>
#include <cstring>

namespace margelo::nitro::editorengine {

SyntaxEngine::SyntaxEngine(const PieceTable* pieceTable) : pieceTable_(pieceTable) {
    parser_ = ts_parser_new();
    ts_parser_set_language(parser_, tree_sitter_javascript());
    tree_ = nullptr;
    query_ = nullptr;
    
    const char* query_source = R"(        (identifier) @variable
        (string) @string
        (number) @number
        (comment) @comment
        (function_declaration name: (identifier) @function)
        (call_expression function: (identifier) @function)
        (property_identifier) @property
        [
          "import" "export" "from" "class" "function" "const" "let" "var"
          "if" "else" "for" "while" "do" "switch" "case" "return" "break"
          "continue" "yield" "await" "async" "try" "catch" "finally" "throw"
          "new" "delete" "typeof" "instanceof" "in" "of" "true" "false" "null"
        ] @keyword
    )";
    uint32_t error_offset;
    TSQueryError error_type;
    query_ = ts_query_new(tree_sitter_javascript(), query_source, strlen(query_source), &error_offset, &error_type);
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
    
    TSInputEdit edit;
    edit.start_byte = startByte;
    edit.old_end_byte = oldEndByte;
    edit.new_end_byte = newEndByte;
    
    edit.start_point = {static_cast<uint32_t>(startPos.line - 1), static_cast<uint32_t>(startPos.column)};
    edit.old_end_point = {static_cast<uint32_t>(oldEndPos.line - 1), static_cast<uint32_t>(oldEndPos.column)};
    edit.new_end_point = {static_cast<uint32_t>(newEndPos.line - 1), static_cast<uint32_t>(newEndPos.column)};
    
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
    if (!tree_ || !query_) return tokens;
    
    TSNode root_node = ts_tree_root_node(tree_);
    
    TSQueryCursor* cursor = ts_query_cursor_new();
    
    TSPoint start_point = {static_cast<uint32_t>(startLine - 1), 0};
    TSPoint end_point = {static_cast<uint32_t>(endLine), 0};
    ts_query_cursor_set_point_range(cursor, start_point, end_point);
    
    ts_query_cursor_exec(cursor, query_, root_node);
    
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
            
            if (start.row == end.row) {
                tokens.push_back(SyntaxToken(
                    static_cast<double>(start.row + 1),
                    static_cast<double>(start.column),
                    static_cast<double>(end.column),
                    tokenType
                ));
            } else {
                // Multi-line token: yield one segment per line
                for (uint32_t r = start.row; r <= end.row; ++r) {
                    double sCol = (r == start.row) ? static_cast<double>(start.column) : 0.0;
                    double eCol = (r == end.row) ? static_cast<double>(end.column) : 999999.0; // Extend to end of line
                    tokens.push_back(SyntaxToken(
                        static_cast<double>(r + 1),
                        sCol,
                        eCol,
                        tokenType
                    ));
                }
            }
        }
    }
    
    ts_query_cursor_delete(cursor);
    return tokens;
}

} // namespace margelo::nitro::editorengine
