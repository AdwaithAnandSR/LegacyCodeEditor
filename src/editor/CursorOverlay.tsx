import React, { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedReaction,
  withRepeat,
  withTiming,
  withDelay,
  cancelAnimation,
  type SharedValue,
} from "react-native-reanimated";
import { EDITOR_THEME } from "./theme";

export interface CursorOverlayProps {
  docX: SharedValue<number>;
  docY: SharedValue<number>;
  scrollX: SharedValue<number>;
  scrollY: SharedValue<number>;
  visible: SharedValue<boolean>;
  active?: boolean;
  activityCount: SharedValue<number>;
}

export function CursorOverlay({
  docX,
  docY,
  scrollX,
  scrollY,
  visible,
  active = true,
  activityCount,
}: CursorOverlayProps) {
  const opacity = useSharedValue(1);
  const opacityRef = useRef(opacity);

  useEffect(() => {
    const sv = opacityRef.current;
    if (!active) {
      cancelAnimation(sv);
      sv.value = 0;
      return;
    }

    cancelAnimation(sv);
    sv.value = 1;
    sv.value = withDelay(
      400,
      withRepeat(
        withTiming(0, { duration: EDITOR_THEME.cursorBlinkIntervalMs }),
        -1,
        true
      )
    );

    return () => {
      cancelAnimation(sv);
    };
  }, [active]);

  useAnimatedReaction(
    () => activityCount.value,
    (curr, prev) => {
      "worklet";
      if (curr !== prev) {
        cancelAnimation(opacity);
        opacity.value = 1;
        opacity.value = withDelay(
          400,
          withRepeat(
            withTiming(0, { duration: EDITOR_THEME.cursorBlinkIntervalMs }),
            -1,
            true
          )
        );
      }
    }
  );

  const animatedStyle = useAnimatedStyle(() => {
    const screenX = docX.value - scrollX.value;
    const screenY = docY.value - scrollY.value;
    const isBehindGutter = screenX < EDITOR_THEME.gutterWidth;
    return {
      opacity: visible.value && !isBehindGutter ? opacity.value : 0,
      transform: [
        { translateX: screenX },
        { translateY: screenY },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.cursor,
        {
          width: EDITOR_THEME.cursorWidth,
          height: EDITOR_THEME.lineHeight,
          backgroundColor: EDITOR_THEME.cursorColor,
        },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  cursor: {
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: 10,
  },
});
