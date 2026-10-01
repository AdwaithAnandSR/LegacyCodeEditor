#include <iostream>
#include <string>
#include <cstring>
#include "editor-engine/cpp/tree-sitter/include/tree_sitter/api.h"

extern "C" TSLanguage *tree_sitter_javascript();

int main() {
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
        "true" @keyword
        "false" @keyword
        "null" @keyword
    )";
    uint32_t error_offset;
    TSQueryError error_type;
    TSQuery* query = ts_query_new(tree_sitter_javascript(), query_source, strlen(query_source), &error_offset, &error_type);
    if (!query) {
        std::cout << "Query Error: type " << error_type << " at offset " << error_offset << "\n";
        if (error_offset < strlen(query_source)) {
            std::cout << "Error near: " << (query_source + error_offset) << "\n";
        }
    } else {
        std::cout << "Query OK\n";
    }
    return 0;
}
