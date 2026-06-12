import { useEffect, useRef, useState, useCallback } from "react";

const TIMEOUT_MS  = 240_000; // 4 minutes
const WARNING_MS  =  30_000; // show warning at 30 s remaining

export type SessionState = "active" | "warning" | "expired";

interface UseInactivityReturn {
  sessionState:    SessionState;
  secondsLeft:     number;
  resetTimer:      () => void;
}

/**
 * Tracks user inactivity. Fires onExpire after TIMEOUT_MS of no activity.
 * Exposes secondsLeft and sessionState so the UI can show a warning.
 * Activity events (mouse, keyboard, touch, scroll) reset the countdown.
 */
export function useInactivityTimer(
  active:   boolean,   // only run when wallet is connected
  onExpire: () => void
): UseInactivityReturn {
  const [secondsLeft,  setSecondsLeft]  = useState(TIMEOUT_MS / 1000);
  const [sessionState, setSessionState] = useState<SessionState>("active");

  const deadlineRef  = useRef<number>(0);
  const rafRef       = useRef<number>(0);
  const onExpireRef  = useRef(onExpire);
  onExpireRef.current = onExpire; // keep ref fresh without re-subscribing

  const resetTimer = useCallback(() => {
    deadlineRef.current = Date.now() + TIMEOUT_MS;
    setSecondsLeft(TIMEOUT_MS / 1000);
    setSessionState("active");
  }, []);

  // Tick every second using rAF-based loop
  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(rafRef.current);
      setSecondsLeft(TIMEOUT_MS / 1000);
      setSessionState("active");
      return;
    }

    deadlineRef.current = Date.now() + TIMEOUT_MS;

    const tick = () => {
      const remaining = deadlineRef.current - Date.now();

      if (remaining <= 0) {
        setSecondsLeft(0);
        setSessionState("expired");
        onExpireRef.current();
        return; // stop loop
      }

      const secs = Math.ceil(remaining / 1000);
      setSecondsLeft(secs);
      setSessionState(remaining <= WARNING_MS ? "warning" : "active");
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  // Reset on any user interaction
  useEffect(() => {
    if (!active) return;

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
    const handler = () => resetTimer();

    events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, handler));
  }, [active, resetTimer]);

  return { sessionState, secondsLeft, resetTimer };
}
