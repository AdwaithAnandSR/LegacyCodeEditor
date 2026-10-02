import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { SharedValue, 
  useSharedValue, 
  useAnimatedStyle, 
  withTiming, 
  runOnJS,
  withSpring
} from 'react-native-reanimated';
import { EDITOR_THEME } from './theme';

interface SwipeButtonProps {
  label: string;
  onTap: () => void;
  options: { label: string; onSelect: () => void }[];
  width?: number;
}

const OPTION_WIDTH = 40;
const OPTION_HEIGHT = 44;

export function SwipeButton({ label, onTap, options, width }: SwipeButtonProps) {
  const isPressed = useSharedValue(false);
  const showPopup = useSharedValue(false);
  const activeIndex = useSharedValue(-1);

  const handleTap = () => {
    onTap();
  };

  const handleSelect = (index: number) => {
    if (index >= 0 && index < options.length) {
      options[index].onSelect();
    }
  };

  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      isPressed.value = true;
    })
    .onEnd(() => {
      runOnJS(handleTap)();
    })
    .onFinalize(() => {
      isPressed.value = false;
    });

  const panGesture = Gesture.Pan()
    .activateAfterLongPress(150)
    .onStart(() => {
      isPressed.value = true;
      showPopup.value = true;
    })
    .onUpdate((e) => {
      // Calculate which option we're over
      // Popup is centered above the button
      const numOptions = options.length;
      const popupWidth = numOptions * OPTION_WIDTH;
      
      // Local x is relative to the button
      // We want to map it to the popup
      // The popup is shifted left by (popupWidth - buttonWidth) / 2
      const buttonWidth = width ?? 44;
      const xInPopup = e.x + (popupWidth - buttonWidth) / 2;
      
      // y needs to be negative (above the button)
      if (e.y < 0 && e.y > -80) {
        const index = Math.floor(xInPopup / OPTION_WIDTH);
        if (index >= 0 && index < numOptions) {
          activeIndex.value = index;
        } else {
          activeIndex.value = -1;
        }
      } else {
        activeIndex.value = -1;
      }
    })
    .onEnd(() => {
      if (activeIndex.value !== -1) {
        runOnJS(handleSelect)(activeIndex.value);
      }
    })
    .onFinalize(() => {
      isPressed.value = false;
      showPopup.value = false;
      activeIndex.value = -1;
    });

  const gesture = Gesture.Simultaneous(tapGesture, panGesture);

  const buttonStyle = useAnimatedStyle(() => {
    return {
      backgroundColor: isPressed.value ? '#444' : '#2D2D2D',
      transform: [{ scale: isPressed.value ? 0.95 : 1 }],
    };
  });

  const popupStyle = useAnimatedStyle(() => {
    return {
      opacity: withTiming(showPopup.value ? 1 : 0, { duration: 150 }),
      transform: [
        { translateY: withSpring(showPopup.value ? -OPTION_HEIGHT - 10 : 0) },
        { scale: withSpring(showPopup.value ? 1 : 0.8) }
      ],
      pointerEvents: showPopup.value ? 'auto' : 'none',
    };
  });

  return (
    <View style={[styles.container, width !== undefined && { width }]}>
      {/* Popup Menu */}
      <Animated.View style={[styles.popup, popupStyle]}>
        {options.map((opt, i) => (
          <PopupOption key={i} index={i} label={opt.label} activeIndex={activeIndex} />
        ))}
      </Animated.View>

      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[
            styles.button,
            buttonStyle,
            width !== undefined && { width: '100%', minWidth: width },
          ]}
        >
          <Text style={styles.label}>{label}</Text>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function PopupOption({ index, label, activeIndex }: { index: number, label: string, activeIndex: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const isActive = activeIndex.value === index;
    return {
      backgroundColor: isActive ? '#007AFF' : 'transparent',
    };
  });

  return (
    <Animated.View style={[styles.popupOption, style]}>
      <Text style={styles.popupLabel}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    overflow: 'visible',
  },
  button: {
    height: 36,
    paddingHorizontal: 4,
    borderRadius: 6,
    backgroundColor: '#2D2D2D',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  label: {
    color: '#D4D4D4',
    fontSize: 14,
    fontWeight: '500',
    fontFamily: EDITOR_THEME.fontFamily,
  },
  popup: {
    position: 'absolute',
    top: 0,
    flexDirection: 'row',
    backgroundColor: '#1E1E1E',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#444',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
    zIndex: 1000,
  },
  popupOption: {
    width: OPTION_WIDTH,
    height: OPTION_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  popupLabel: {
    color: '#D4D4D4',
    fontSize: 18,
    fontFamily: EDITOR_THEME.fontFamily,
  },
});
