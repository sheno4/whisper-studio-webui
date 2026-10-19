import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

interface ContentTransition<T> {
  contentRef: RefObject<HTMLDivElement | null>;
  displayedValue: T;
  displayedKey: string;
}

/** Keep the existing content until it fades out; polling within a view stays live. */
export function useContentTransition<T>(value: T, transitionKey: string): ContentTransition<T> {
  const contentRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ value, key: transitionKey });
  latest.current = { value, key: transitionKey };
  const [displayedKey, setDisplayedKey] = useState(transitionKey);
  const retainedValue = useRef(value);
  const displayedValue = displayedKey === transitionKey ? value : retainedValue.current;
  const activeAnimation = useRef<Animation | null>(null);
  const pendingEntry = useRef<string | null>(null);
  const generation = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useLayoutEffect(() => { retainedValue.current = displayedValue; });

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = (): void => setReducedMotion(media.matches);
    const settleHiddenContent = (): void => {
      if (!document.hidden) return;
      generation.current += 1;
      activeAnimation.current?.cancel();
      activeAnimation.current = null;
      pendingEntry.current = null;
      setDisplayedKey(latest.current.key);
    };
    media.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', settleHiddenContent);
    return () => {
      media.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', settleHiddenContent);
      generation.current += 1;
      activeAnimation.current?.cancel();
      activeAnimation.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const node = contentRef.current;
    const changingContent = displayedKey !== transitionKey;
    if (!changingContent && !activeAnimation.current && pendingEntry.current === null) return;
    if (!node || typeof node.animate !== 'function' || document.hidden) {
      generation.current += 1;
      activeAnimation.current?.cancel();
      activeAnimation.current = null;
      pendingEntry.current = null;
      if (changingContent) setDisplayedKey(transitionKey);
      return;
    }

    // Sample before cancelling so rapid changes continue from the visible frame.
    const presentation = getComputedStyle(node);
    const opacity = presentation.opacity;
    const transform = reducedMotion ? 'none' : presentation.transform;
    const easing = presentation.getPropertyValue('--ease-out').trim() || 'cubic-bezier(0.23, 1, 0.32, 1)';
    const interrupted = activeAnimation.current;
    const run = ++generation.current;
    if (interrupted) interrupted.onfinish = null;
    interrupted?.cancel();

    const exitDuration = reducedMotion ? 40 : 60;
    const enterDuration = reducedMotion ? 80 : 120;
    const enteringNewContent = !changingContent && pendingEntry.current === displayedKey;
    pendingEntry.current = null;
    const duration = changingContent ? Math.max(1, exitDuration * Number(opacity)) : enterDuration;
    const from = enteringNewContent
      ? { opacity: 0, transform: reducedMotion ? 'none' : 'translateY(3px)' }
      : { opacity, transform };
    const to = changingContent
      ? { opacity: 0, transform: reducedMotion ? 'none' : 'translateY(-2px)' }
      : { opacity: 1, transform: reducedMotion ? 'none' : 'translateY(0)' };
    const animation = node.animate([from, to], { duration, easing, fill: 'both' });
    activeAnimation.current = animation;

    // WAAPI does not mutate style attributes. Notify each actual phase, including
    // a delayed React commit, so the shared optical clock follows its full pose.
    node.dispatchEvent(new CustomEvent('lg:optics', {
      bubbles: true,
      detail: { duration: duration + 32 }
    }));

    animation.onfinish = () => {
      if (generation.current !== run) return;
      if (changingContent) {
        pendingEntry.current = latest.current.key;
        setDisplayedKey(latest.current.key);
      } else {
        activeAnimation.current = null;
        animation.cancel();
        node.dispatchEvent(new CustomEvent('lg:optics', {bubbles: true, detail: {duration: 32}}));
      }
    };
  }, [transitionKey, displayedKey, reducedMotion]);

  return { contentRef, displayedValue, displayedKey };
}
