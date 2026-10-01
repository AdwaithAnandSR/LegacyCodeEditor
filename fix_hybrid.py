import re

with open('editor-engine/cpp/HybridEditorEngine.hpp', 'r') as f:
    lines = f.readlines()

new_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    if "if (syntaxEngine_) syntaxEngine_->parseFull();" in line and "}" in lines[i-1]:
        # This was inserted outside a block. We need to move it inside.
        # Find the previous closing brace.
        pass # We will handle it by replacing the block properly
    else:
        new_lines.append(line)
    i += 1

with open('editor-engine/cpp/HybridEditorEngine.hpp', 'w') as f:
    f.writelines(new_lines)

# Now just do a proper regex on the whole content
with open('editor-engine/cpp/HybridEditorEngine.hpp', 'r') as f:
    content = f.read()

content = content.replace(
    "savedContentHash_ = computeHash(content);\n    }",
    "savedContentHash_ = computeHash(content);\n        if (syntaxEngine_) syntaxEngine_->parseFull();\n    }"
)

# Also check undo redo
content = content.replace(
    "            }\n            if (syntaxEngine_) syntaxEngine_->parseFull();\n        }",
    "            }\n        }\n        if (syntaxEngine_) syntaxEngine_->parseFull();"
)

with open('editor-engine/cpp/HybridEditorEngine.hpp', 'w') as f:
    f.write(content)
