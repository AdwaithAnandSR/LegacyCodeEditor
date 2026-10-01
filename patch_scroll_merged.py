import re

with open('src/editor/useEditorScroll.ts', 'r') as f:
    content = f.read()

# Remove handleDragGesture entirely
content = re.sub(r'  const handleDragGesture = Gesture\.Pan\(\)\n.*?\.runOnJS\(true\);\n\n', '', content, flags=re.DOTALL)

# Update panGesture
pan_gesture_old = """  const panGesture = Gesture.Pan()
    .onBegin(() => {
      wasScrolling.current = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
    })
    .onStart((e) => {
      panStartY.current = stateManager.scrollOffset.y;
      panStartX.current = stateManager.scrollOffset.x;
      panStartTranslation.current = { x: e.translationX, y: e.translationY };
      scrollLock.current = 'none';
      frozenX.current = 0;
      frozenY.current = 0;
    })
    .onUpdate((e) => {
      const activeTranslationY = e.translationY - panStartTranslation.current.y;
      const activeTranslationX = e.translationX - panStartTranslation.current.x;"""

pan_gesture_new = """  const panGesture = Gesture.Pan()
    .onBegin((e) => {
      wasScrolling.current = stateManager.isMomentumScrolling();
      stateManager.stopMomentumScroll();
      const handle = stateManager.getHandleAt(e.x, e.y);
      if (handle) {
        stateManager.activeHandle = handle;
      }
    })
    .onStart((e) => {
      if (stateManager.activeHandle) return;
      panStartY.current = stateManager.scrollOffset.y;
      panStartX.current = stateManager.scrollOffset.x;
      panStartTranslation.current = { x: e.translationX, y: e.translationY };
      scrollLock.current = 'none';
      frozenX.current = 0;
      frozenY.current = 0;
    })
    .onUpdate((e) => {
      if (stateManager.activeHandle) {
        stateManager.handleHandleDrag(e.x, e.y);
        return;
      }
      const activeTranslationY = e.translationY - panStartTranslation.current.y;
      const activeTranslationX = e.translationX - panStartTranslation.current.x;"""

content = content.replace(pan_gesture_old, pan_gesture_new)

pan_gesture_end_old = """      stateManager.invalidate();
    })
    .onEnd((e) => {
      const velX = scrollLock.current === 'vertical' ? 0 : e.velocityX;
      const velY = scrollLock.current === 'horizontal' ? 0 : e.velocityY;
      stateManager.startMomentumScroll(velX, velY);
    })"""

pan_gesture_end_new = """      stateManager.invalidate();
    })
    .onEnd((e) => {
      if (stateManager.activeHandle) {
        stateManager.activeHandle = null;
        return;
      }
      const velX = scrollLock.current === 'vertical' ? 0 : e.velocityX;
      const velY = scrollLock.current === 'horizontal' ? 0 : e.velocityY;
      stateManager.startMomentumScroll(velX, velY);
    })"""

content = content.replace(pan_gesture_end_old, pan_gesture_end_new)

# Restore Exclusive
content = content.replace(
    "  const gesture = Gesture.Exclusive(handleDragGesture, selectionPanGesture, panGesture, tapGesture);",
    "  const gesture = Gesture.Exclusive(selectionPanGesture, panGesture, tapGesture);"
)

with open('src/editor/useEditorScroll.ts', 'w') as f:
    f.write(content)
