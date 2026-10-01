#include <stdio.h>
#include <string.h>
#include "editor-engine/cpp/tree-sitter/include/tree_sitter/api.h"

extern TSLanguage *tree_sitter_javascript();

int main() {
    const char* query_source = "(identifier) @variable\n(string) @string\n(number) @number\n(comment) @comment\n(property_identifier) @property\n(function_declaration name: (identifier) @function)\n(call_expression function: (identifier) @function)\n\"import\" @keyword\n\"export\" @keyword\n\"from\" @keyword\n\"class\" @keyword\n\"function\" @keyword\n\"const\" @keyword\n\"let\" @keyword\n\"var\" @keyword\n\"if\" @keyword\n\"else\" @keyword\n\"for\" @keyword\n\"while\" @keyword\n\"do\" @keyword\n\"switch\" @keyword\n\"case\" @keyword\n\"return\" @keyword\n\"break\" @keyword\n\"continue\" @keyword\n\"yield\" @keyword\n\"await\" @keyword\n\"async\" @keyword\n\"try\" @keyword\n\"catch\" @keyword\n\"finally\" @keyword\n\"throw\" @keyword\n\"new\" @keyword\n\"delete\" @keyword\n\"typeof\" @keyword\n\"instanceof\" @keyword\n\"in\" @keyword\n\"of\" @keyword\n\"true\" @keyword\n\"false\" @keyword\n\"null\" @keyword";
    uint32_t error_offset;
    TSQueryError error_type;
    TSQuery* query = ts_query_new(tree_sitter_javascript(), query_source, strlen(query_source), &error_offset, &error_type);
    if (!query) {
        printf("Query Error: type %d at offset %d\n", error_type, error_offset);
        if (error_offset < strlen(query_source)) {
            printf("Error near: %s\n", query_source + error_offset);
        }
    } else {
        printf("Query OK\n");
    }
    return 0;
}
