// components/TapTheDotGameModal.tsx
//
// "Tap the Dot" mini-game shown while a snapshot refresh runs in the background.
//
// Props:
//   visible          - controls the RN Modal
//   onClose          - called when user taps the ✕ close button
//   snapshotRunning  - true while capture is in progress (drives status pill)
//   snapshotDone     - set to true exactly once when the snapshot finishes OK
//   snapshotError    - set to a message if the snapshot failed

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  LayoutChangeEvent,
  Platform,
  StatusBar,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTapDotHighScore } from '@/hooks/useTapDotHighScore';
import C from '@/lib/colors';

// ── Constants ─────────────────────────────────────────────────────────────────

const GAME_DURATION_S = 30;
const DOT_RADIUS       = 28;   // half of touch-target width/height
const DOT_VISUAL_R     = 22;   // visual radius for inner circle
const HEADER_H         = 60;   // space reserved for in-game header (score row)
const FOOTER_H         = 0;    // optional future use

// ── Types ─────────────────────────────────────────────────────────────────────

interface DotPosition { x: number; y: number }

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomDot(areaW: number, areaH: number): DotPosition {
  const minX = DOT_RADIUS;
  const maxX = areaW - DOT_RADIUS;
  const minY = HEADER_H + DOT_RADIUS;
  const maxY = areaH - DOT_RADIUS - FOOTER_H;
  return {
    x: minX + Math.random() * (maxX - minX),
    y: minY + Math.random() * (maxY - minY),
  };
}

function formatTime(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── Toast component ───────────────────────────────────────────────────────────

interface ToastProps { message: string; isError?: boolean }

function InModalToast({ message, isError }: ToastProps) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(3500),
      Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
  }, [message]); // re-trigger if message changes

  return (
    <Animated.View style={[styles.toast, isError && styles.toastError, { opacity }]}>
      <Ionicons
        name={isError ? 'alert-circle-outline' : 'checkmark-circle-outline'}
        size={16}
        color={isError ? C.red : C.green}
        style={{ marginRight: 6 }}
      />
      <Text style={[styles.toastText, isError && { color: C.red }]}>{message}</Text>
    </Animated.View>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export interface TapTheDotGameModalProps {
  visible:         boolean;
  onClose:         () => void;
  snapshotRunning: boolean;
  snapshotDone:    boolean;
  snapshotError?:  string | null;
}

type GameState = 'idle' | 'running' | 'complete';

export function TapTheDotGameModal({
  visible,
  onClose,
  snapshotRunning,
  snapshotDone,
  snapshotError,
}: TapTheDotGameModalProps) {
  const { highScore, loaded, maybeUpdate } = useTapDotHighScore();

  // ── Game state ─────────────────────────────────────────────────────────────
  const [gameState,  setGameState]  = useState<GameState>('idle');
  const [score,      setScore]      = useState(0);
  const [timeLeft,   setTimeLeft]   = useState(GAME_DURATION_S);
  const [dotPos,     setDotPos]     = useState<DotPosition | null>(null);
  const [areaSize,   setAreaSize]   = useState({ w: 0, h: 0 });

  // ── Toast state ────────────────────────────────────────────────────────────
  const [toastMsg,   setToastMsg]    = useState<string | null>(null);
  const [toastError, setToastError]  = useState(false);
  const [toastKey,   setToastKey]    = useState(0);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const scoreRef       = useRef(0);          // shadow for closure-safe end-of-game read
  // Track previous snapshotDone/Error so we only fire the toast on transition
  const prevDoneRef    = useRef(false);
  const prevErrorRef   = useRef<string | null | undefined>(null);

  // ── Show toast helper ─────────────────────────────────────────────────────
  const showToast = useCallback((msg: string, isError = false) => {
    setToastMsg(msg);
    setToastError(isError);
    setToastKey((k) => k + 1);
  }, []);

  // ── Watch snapshot state → show in-modal toast on transition ─────────────
  useEffect(() => {
    if (!visible) return;

    if (snapshotDone && !prevDoneRef.current) {
      showToast('Snapshot complete ✓  You can close the game anytime.');
    }
    prevDoneRef.current = snapshotDone;
  }, [snapshotDone, visible, showToast]);

  useEffect(() => {
    if (!visible) return;
    if (snapshotError && snapshotError !== prevErrorRef.current) {
      showToast(`Snapshot failed: ${snapshotError}`, true);
    }
    prevErrorRef.current = snapshotError;
  }, [snapshotError, visible, showToast]);

  // ── Reset when modal opens ─────────────────────────────────────────────────
  useEffect(() => {
    if (visible) {
      resetGame();
      prevDoneRef.current  = snapshotDone;
      prevErrorRef.current = snapshotError;
    } else {
      stopTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ── Timer logic ────────────────────────────────────────────────────────────
  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          maybeUpdate(scoreRef.current);
          setGameState('complete');
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }, [stopTimer, maybeUpdate]);

  // ── Game actions ───────────────────────────────────────────────────────────
  const resetGame = useCallback(() => {
    stopTimer();
    setGameState('idle');
    setScore(0);
    scoreRef.current = 0;
    setTimeLeft(GAME_DURATION_S);
    setDotPos(null);
  }, [stopTimer]);

  const startGame = useCallback(() => {
    if (areaSize.w === 0 || areaSize.h === 0) return; // layout not ready yet
    setScore(0);
    scoreRef.current = 0;
    setTimeLeft(GAME_DURATION_S);
    setDotPos(randomDot(areaSize.w, areaSize.h));
    setGameState('running');
    startTimer();
  }, [areaSize, startTimer]);

  const handleTap = useCallback(() => {
    if (gameState !== 'running') return;
    const next = scoreRef.current + 1;
    scoreRef.current = next;
    setScore(next);
    // Move dot immediately
    setDotPos(randomDot(areaSize.w, areaSize.h));
    // Haptics — graceful no-op if expo-haptics not installed
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Haptics = require('expo-haptics');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch { /* not installed */ }
  }, [gameState, areaSize]);

  // ── Area layout ───────────────────────────────────────────────────────────
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setAreaSize({ w: width, h: height });
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => () => stopTimer(), [stopTimer]);

  // ── Status pill ───────────────────────────────────────────────────────────
  const pillLabel  = snapshotError ? 'Error' : snapshotRunning ? 'Running' : 'Complete';
  const pillColor  = snapshotError ? C.red   : snapshotRunning ? C.amber   : C.green;
  const pillBg     = snapshotError ? C.redDim: snapshotRunning ? C.amberDim: C.greenDim;

  // ── Dot scale animation ───────────────────────────────────────────────────
  const dotScale = useRef(new Animated.Value(1)).current;

  const animateDot = useCallback(() => {
    dotScale.setValue(0.7);
    Animated.spring(dotScale, {
      toValue: 1, useNativeDriver: true, speed: 40, bounciness: 10,
    }).start();
  }, [dotScale]);

  // Trigger dot spawn animation
  const prevDotPos = useRef<DotPosition | null>(null);
  useEffect(() => {
    if (dotPos && dotPos !== prevDotPos.current) {
      animateDot();
      prevDotPos.current = dotPos;
    }
  }, [dotPos, animateDot]);

  // ── Time-bar progress ─────────────────────────────────────────────────────
  const timeProgress = timeLeft / GAME_DURATION_S;  // 1→0
  const timeBarColor = timeLeft > 10 ? C.accent : C.red;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        {/* ── Modal header ──────────────────────────────────────────── */}
        <View style={styles.modalHeader}>
          <View style={styles.modalHeaderLeft}>
            <Text style={styles.modalTitle}>Tap the Dot</Text>
            <View style={[styles.statusPill, { backgroundColor: pillBg }]}>
              <View style={[styles.statusDot, { backgroundColor: pillColor }]} />
              <Text style={[styles.statusLabel, { color: pillColor }]}>{pillLabel}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={22} color={C.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* ── In-modal toast ─────────────────────────────────────────── */}
        {toastMsg !== null && (
          <InModalToast key={toastKey} message={toastMsg} isError={toastError} />
        )}

        {/* ── Score / time bar row ───────────────────────────────────── */}
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Score</Text>
            <Text style={styles.statValue}>{score}</Text>
          </View>
          <View style={styles.timeBox}>
            <Text style={styles.statLabel}>Time</Text>
            <Text style={[styles.statValue, timeLeft <= 10 && styles.statValueDanger]}>
              {formatTime(timeLeft)}
            </Text>
            {/* time bar */}
            <View style={styles.timeBarBg}>
              <View style={[styles.timeBarFill, {
                width: `${timeProgress * 100}%` as any,
                backgroundColor: timeBarColor,
              }]} />
            </View>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Best</Text>
            <Text style={styles.statValue}>{loaded ? highScore : '—'}</Text>
          </View>
        </View>

        {/* ── Game area ─────────────────────────────────────────────── */}
        <TouchableWithoutFeedback onPress={gameState === 'running' ? undefined : undefined}>
          <View style={styles.gameArea} onLayout={handleLayout}>

            {/* Dot */}
            {gameState === 'running' && dotPos !== null && (
              <TouchableWithoutFeedback onPress={handleTap}>
                <Animated.View style={[
                  styles.dotOuter,
                  {
                    left:      dotPos.x - DOT_RADIUS,
                    top:       dotPos.y - DOT_RADIUS,
                    transform: [{ scale: dotScale }],
                  },
                ]}>
                  <View style={styles.dotInner} />
                  <View style={styles.dotRing} />
                </Animated.View>
              </TouchableWithoutFeedback>
            )}

            {/* Idle overlay */}
            {gameState === 'idle' && (
              <View style={styles.overlay} pointerEvents="box-none">
                <Text style={styles.overlayTitle}>Ready?</Text>
                <Text style={styles.overlayBody}>Tap the dot as fast as you can{'\n'}before 30 seconds run out.</Text>
                <TouchableOpacity style={styles.primaryBtn} onPress={startGame}>
                  <Ionicons name="play" size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={styles.primaryBtnText}>Start Game</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Run complete overlay */}
            {gameState === 'complete' && (
              <View style={styles.overlay} pointerEvents="box-none">
                <Text style={styles.overlayTitle}>Run Complete!</Text>
                <Text style={styles.overlayScore}>{score}</Text>
                <Text style={styles.overlayScoreLabel}>points</Text>
                {score >= highScore && score > 0 && (
                  <View style={styles.newHighBadge}>
                    <Ionicons name="trophy" size={14} color={C.amber} style={{ marginRight: 4 }} />
                    <Text style={styles.newHighText}>New high score!</Text>
                  </View>
                )}
                <TouchableOpacity style={styles.primaryBtn} onPress={startGame}>
                  <Ionicons name="refresh" size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={styles.primaryBtnText}>Play Again</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </TouchableWithoutFeedback>
      </View>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex:            1,
    backgroundColor: C.black,
  },

  // ── Modal header
  modalHeader: {
    flexDirection:    'row',
    alignItems:       'center',
    justifyContent:   'space-between',
    paddingHorizontal: 20,
    paddingTop:        Platform.OS === 'android'
                         ? (StatusBar.currentHeight ?? 24) + 12
                         : 56,
    paddingBottom:    12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  modalHeaderLeft: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           10,
  },
  modalTitle: {
    color:      C.textPrimary,
    fontSize:   18,
    fontWeight: '700',
  },
  statusPill: {
    flexDirection:   'row',
    alignItems:      'center',
    borderRadius:    20,
    paddingVertical:  3,
    paddingHorizontal: 8,
    gap:             5,
  },
  statusDot: {
    width:        6,
    height:       6,
    borderRadius: 3,
  },
  statusLabel: {
    fontSize:   11,
    fontWeight: '600',
  },
  closeBtn: {
    width:           34,
    height:          34,
    borderRadius:    17,
    backgroundColor: C.surfaceAlt,
    alignItems:      'center',
    justifyContent:  'center',
  },

  // ── Toast
  toast: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.greenDim,
    borderRadius:    10,
    marginHorizontal: 16,
    marginTop:       10,
    paddingVertical:  10,
    paddingHorizontal: 14,
    borderWidth:     1,
    borderColor:     C.green,
  },
  toastError: {
    backgroundColor: C.redDim,
    borderColor:     C.red,
  },
  toastText: {
    color:    C.green,
    fontSize: 13,
    flex:     1,
    lineHeight: 18,
  },

  // ── Stats row
  statsRow: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    paddingHorizontal: 16,
    paddingVertical:  14,
    gap:              8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  statBox: {
    flex:      1,
    alignItems: 'center',
  },
  timeBox: {
    flex:      1.4,
    alignItems: 'center',
  },
  statLabel: {
    color:      C.textMuted,
    fontSize:   11,
    fontWeight: '500',
    marginBottom: 3,
  },
  statValue: {
    color:      C.textPrimary,
    fontSize:   24,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  statValueDanger: {
    color: C.red,
  },
  timeBarBg: {
    width:           '80%',
    height:          4,
    backgroundColor: C.border,
    borderRadius:    2,
    marginTop:       5,
    overflow:        'hidden',
  },
  timeBarFill: {
    height:       4,
    borderRadius: 2,
  },

  // ── Game area
  gameArea: {
    flex:            1,
    backgroundColor: C.surface,
    margin:          12,
    borderRadius:    16,
    overflow:        'hidden',
    borderWidth:     1,
    borderColor:     C.border,
  },

  // ── Dot
  dotOuter: {
    position:        'absolute',
    width:           DOT_RADIUS * 2,
    height:          DOT_RADIUS * 2,
    alignItems:      'center',
    justifyContent:  'center',
  },
  dotRing: {
    position:        'absolute',
    width:           DOT_RADIUS * 2,
    height:          DOT_RADIUS * 2,
    borderRadius:    DOT_RADIUS,
    borderWidth:     2,
    borderColor:     C.accentLight,
    opacity:         0.4,
  },
  dotInner: {
    width:           DOT_VISUAL_R * 2,
    height:          DOT_VISUAL_R * 2,
    borderRadius:    DOT_VISUAL_R,
    backgroundColor: C.accent,
    shadowColor:     C.accent,
    shadowOffset:    { width: 0, height: 0 },
    shadowOpacity:   0.7,
    shadowRadius:    12,
    elevation:       8,
  },

  // ── Overlays (idle / complete)
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems:       'center',
    justifyContent:   'center',
    backgroundColor:  'rgba(10,10,10,0.82)',
    gap:              12,
  },
  overlayTitle: {
    color:      C.textPrimary,
    fontSize:   28,
    fontWeight: '800',
  },
  overlayBody: {
    color:      C.textSecondary,
    fontSize:   15,
    textAlign:  'center',
    lineHeight: 22,
  },
  overlayScore: {
    color:      C.accent,
    fontSize:   72,
    fontWeight: '900',
    lineHeight: 76,
  },
  overlayScoreLabel: {
    color:      C.textMuted,
    fontSize:   14,
    marginTop:  -8,
  },
  newHighBadge: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.amberDim,
    borderRadius:    20,
    paddingVertical:  5,
    paddingHorizontal: 12,
    borderWidth:     1,
    borderColor:     C.amber,
  },
  newHighText: {
    color:      C.amber,
    fontSize:   13,
    fontWeight: '600',
  },

  // ── Primary button (Start / Play Again)
  primaryBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.accent,
    borderRadius:    24,
    paddingVertical:  13,
    paddingHorizontal: 28,
    marginTop:       8,
    shadowColor:     C.accent,
    shadowOffset:    { width: 0, height: 4 },
    shadowOpacity:   0.35,
    shadowRadius:    8,
    elevation:       6,
  },
  primaryBtnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '700',
  },
});
