import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type RefObject } from 'react';
import { createLensSurface } from '../vendor/lens/internal/lens-surface.js';
import { useGlassCapability } from './capabilities';

type MaterialProps = {
  radius?: number;
  interactive?: boolean;
  tone?: 'clear' | 'regular' | 'strong';
};
export type GlassSurfaceProps = Omit<HTMLAttributes<HTMLElement>, 'draggable'> & MaterialProps & {
  as?: 'div' | 'section' | 'nav' | 'header' | 'aside' | 'footer';
};
export type GlassButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & MaterialProps;

/** React owns semantic DOM; Lens owns the shared material and spring body. */
function useLensSurface(ref: RefObject<HTMLElement | null>, kind: 'panel' | 'small', motion: 'none' | 'press', className: string) {
  const capability = useGlassCapability();
  const [overlay, setOverlay] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A root canvas sits behind DOM. Dialogs and menus need their own CSS
    // material so opaque containers cannot hide their canvas-rendered surface.
    const domOverlay = Boolean(element.closest('[role="dialog"], [role="menu"], .studio-drop'));
    setOverlay(domOverlay);
    const surface = createLensSurface({ element, kind, motion });
    if (domOverlay) {
      element.dataset.lgDomOverlay = 'true';
      element.removeAttribute('data-glass');
    }
    return () => surface.destroy();
  }, [ref, kind, motion, className]);
  return {
    ...capability,
    mode: overlay && capability.enabled ? 'frosted' : capability.mode,
    source: overlay || !capability.enabled ? undefined : 'lens-scene',
    reason: overlay && capability.enabled ? 'dom-overlay' : capability.reason,
    overlay
  } as const;
}

export const GlassSurface = forwardRef<HTMLElement, GlassSurfaceProps>(function GlassSurface({ as = 'div', className = '', children, radius, interactive = false, tone = 'regular', style, ...props }, forwardedRef) {
  const ref = useRef<HTMLElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const motion = interactive ? 'press' : 'none';
  const glass = useLensSurface(ref, 'panel', motion, className);
  return createElement(as, {
    ...props, ref,
    className: `lg-surface glass-surface ${className}`.trim(),
    'data-glass': glass.overlay ? undefined : 'panel',
    'data-lg-lens': 'panel',
    'data-lg-drag': motion === 'none' ? undefined : motion,
    'data-lg-dom-overlay': glass.overlay || undefined,
    'data-glass-mode': glass.mode,
    'data-glass-source': glass.mode === 'optical' ? glass.source : undefined,
    'data-glass-fallback': glass.mode !== 'optical' ? glass.reason : undefined,
    'data-glass-tone': tone,
    'data-glass-interactive': interactive || undefined,
    style: { ...(radius === undefined ? {} : { '--glass-radius': `${radius}px` }), ...style } as CSSProperties
  }, <span className="glass-surface__content">{children}</span>);
});

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton({ className = '', children, radius = 999, interactive = true, tone = 'regular', style, type = 'button', ...props }, forwardedRef) {
  const ref = useRef<HTMLButtonElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const motion = interactive && !props.disabled ? 'press' : 'none';
  const glass = useLensSurface(ref, 'small', motion, className);
  return <button {...props} ref={ref} type={type} className={`lg-surface glass-button glass-surface ${className}`.trim()} data-glass={glass.overlay ? undefined : 'small'} data-lg-lens="small" data-lg-drag={motion === 'none' ? undefined : motion} data-lg-dom-overlay={glass.overlay || undefined} data-glass-mode={glass.mode} data-glass-source={glass.mode === 'optical' ? glass.source : undefined} data-glass-fallback={glass.mode !== 'optical' ? glass.reason : undefined} data-glass-tone={tone} data-glass-interactive={interactive || undefined} style={{ '--glass-radius': `${radius}px`, ...style } as CSSProperties}>
    <span className="glass-surface__content glass-button__content">{children}</span>
  </button>;
});
