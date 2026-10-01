with open('src/editor/SkiaRenderer.ts', 'r') as f:
    content = f.read()

old_circle = "canvas.drawCircle(x + cursorWidth / 2, y + lineHeight + 6, 6, PAINTS.handle);"
new_circle = "canvas.drawCircle(x + cursorWidth / 2, y + lineHeight + 10, 10, PAINTS.handle);"

content = content.replace(old_circle, new_circle)

with open('src/editor/SkiaRenderer.ts', 'w') as f:
    f.write(content)
