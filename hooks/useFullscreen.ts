'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Borderless full-window mode. The caller renders its container as a fixed full-window overlay while `fs` is true
 * (works everywhere); we additionally ask the browser for real fullscreen, best-effort. Esc exits.
 */
export function useFullscreen() {
  const [fs, setFs] = useState(false);
  const native = useRef(false);

  const exit = useCallback(() => {
    setFs(false);
    if (native.current && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    native.current = false;
  }, []);

  const enter = useCallback(() => {
    setFs(true);
    try {
      document.documentElement.requestFullscreen?.().then(
        () => {
          native.current = true;
        },
        () => {
          /* denied / unsupported: the CSS overlay is still full-window */
        },
      );
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => (fs ? exit() : enter()), [fs, enter, exit]);

  useEffect(() => {
    if (!fs) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[data-overlay]')) {
        e.preventDefault();
        e.stopImmediatePropagation(); // don't also close a modal underneath
        exit();
      }
    };
    const onChange = () => {
      if (!document.fullscreenElement && native.current) {
        native.current = false;
        setFs(false); // user left browser fullscreen with Esc / F11
      }
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onChange);
      document.body.style.overflow = overflow;
    };
  }, [fs, exit]);

  // leaving the page state (unmount) must also leave browser fullscreen
  useEffect(
    () => () => {
      if (native.current && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },
    [],
  );

  return { fs, enter, exit, toggle };
}
