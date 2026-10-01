with open('src/editor/useEditorScroll.ts', 'r') as f:
    content = f.read()

handle_gesture = """  const handleDragGesture = Gesture.Pan()
    .manualActivation(true)
    .onTouchesDown((e, state) => {
      if (e.allTouches.length > 0) {
        const handle = stateManager.getHandleAt(e.allTouches[0].x, e.allTouches[0].y);
        if (handle) {
          stateManager.activeHandle = handle;
          state.activate();
        } else {
          state.fail();
        }
      }
    })
    .onUpdate((e) => {
      stateManager.handleHandleDrag(e.x, e.y);
    })
    .onEnd(() => {
      stateManager.activeHandle = null;
    })
    .runOnJS(true);

  const selectionPanGesture = Gesture.Pan()"""

content = content.replace("  const selectionPanGesture = Gesture.Pan()", handle_gesture)

exclusive = "  const gesture = Gesture.Exclusive(handleDragGesture, selectionPanGesture, panGesture, tapGesture);"
content = content.replace("  const gesture = Gesture.Exclusive(selectionPanGesture, panGesture, tapGesture);", exclusive)

with open('src/editor/useEditorScroll.ts', 'w') as f:
    f.write(content)
