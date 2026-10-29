import React, { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedReaction,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  cancelAnimation,
  type SharedValue,
} from "react-native-reanimated";
import { EDITOR_THEME } from "./theme";

export interface CursorOverlayProps {
  x: SharedValue<number>;
  y: SharedValue<number>;
  visible: SharedValue<boolean>;
  active?: boolean;
  activityCount: SharedValue<number>;
}

export function CursorOverlay({
  x,
  y,
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
        withSequence(
          withTiming(0, { duration: EDITOR_THEME.cursorBlinkIntervalMs }),
          withTiming(1, { duration: EDITOR_THEME.cursorBlinkIntervalMs })
        ),
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
            withSequence(
              withTiming(0, { duration: EDITOR_THEME.cursorBlinkIntervalMs }),
              withTiming(1, { duration: EDITOR_THEME.cursorBlinkIntervalMs })
            ),
            -1,
            true
          )
        );
      }
    }
  );

  const animatedStyle = useAnimatedStyle(() => {
    return {
      opacity: visible.value ? opacity.value : 0,
      transform: [
        { translateX: x.value },
        { translateY: y.value },
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
