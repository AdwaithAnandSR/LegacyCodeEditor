with open('src/editor/theme.ts', 'r') as f:
    content = f.read()

content = content.replace(
    '  cursorColor: "#AEAFAD",',
    '  cursorColor: "#AEAFAD",\n  handleColor: "#569CD6",'
)
with open('src/editor/theme.ts', 'w') as f:
    f.write(content)
