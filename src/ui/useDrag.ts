import { useCallback, useEffect, useRef, useState } from 'react';

/** ドラッグ中のカード。target はドロップ先の data-drop の値 */
export interface DragState {
  uid: string;
  x: number;
  y: number;
  target: string | null;
}

interface Pending {
  uid: string;
  startX: number;
  startY: number;
  touch: boolean;
  active: boolean;
  timer: number | null;
}

/** タッチは少し長押ししてから動かすとドラッグ（すぐ動かすと画面のスクロール） */
const LONG_PRESS_MS = 200;
const MOUSE_THRESHOLD = 6;
const TOUCH_CANCEL = 10;

function dropTargetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-drop]');
  return el?.getAttribute('data-drop') ?? null;
}

export function useDrag(onDrop: (uid: string, target: string, x: number, y: number) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<Pending | null>(null);
  const suppressClick = useRef(false);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const activate = (x: number, y: number) => {
    const p = pending.current;
    if (!p) return;
    p.active = true;
    setDrag({ uid: p.uid, x, y, target: dropTargetAt(x, y) });
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      if (!p) return;
      const dist = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (!p.active) {
        if (p.touch) {
          if (dist > TOUCH_CANCEL) cancel();
        } else if (dist > MOUSE_THRESHOLD) {
          activate(e.clientX, e.clientY);
        }
        return;
      }
      setDrag({ uid: p.uid, x: e.clientX, y: e.clientY, target: dropTargetAt(e.clientX, e.clientY) });
    };
    const onUp = (e: PointerEvent) => {
      const p = pending.current;
      if (!p) return;
      const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TOUCH_CANCEL;
      // 長押ししただけで動かさなかった場合はタップとして扱う
      if (p.active && moved) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        const target = dropTargetAt(e.clientX, e.clientY);
        if (target) dropRef.current(p.uid, target, e.clientX, e.clientY);
      }
      cancel();
    };
    const cancel = () => {
      const p = pending.current;
      if (p?.timer) clearTimeout(p.timer);
      pending.current = null;
      setDrag(null);
    };
    // ドラッグ中はタッチでの画面スクロールを止める
    const onTouchMove = (e: TouchEvent) => {
      if (pending.current?.active) e.preventDefault();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  const dragStart = useCallback(
    (uid: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const touch = e.pointerType !== 'mouse';
      const p: Pending = { uid, startX: e.clientX, startY: e.clientY, touch, active: false, timer: null };
      if (touch) p.timer = window.setTimeout(() => activate(p.startX, p.startY), LONG_PRESS_MS);
      pending.current = p;
    },
    [],
  );

  /** ドラッグの直後に発生するクリックを無視する */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClick.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  return { drag, dragStart, onClickCapture };
}
