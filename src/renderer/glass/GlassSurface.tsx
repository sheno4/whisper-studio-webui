import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type RefObject } from 'react';
import { releaseLensRoot, scheduleLensMount } from '../lens/Runtime';

type MaterialProps = {
  radius?: number;
  interactive?: boolean;
  tone?: 'clear' | 'regular' | 'strong';
};
export type GlassSurfaceProps = Omit<HTMLAttributes<HTMLElement>, 'draggable'> & MaterialProps & {
  as?: 'div' | 'section' | 'nav' | 'header' | 'aside' | 'footer';
};
export type GlassButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & MaterialProps;

/** React owns createLensSurface's public semantic DOM. The shared stage
 * supplies its material and, for buttons, its single press spring. */
function useLensRegistration(ref: RefObject<HTMLElement | null>, motion: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    scheduleLensMount(element);
    return () => releaseLensRoot(element);
  }, [ref, motion]);
}

export const GlassSurface = forwardRef<HTMLElement, GlassSurfaceProps>(function GlassSurface({ as = 'div', className = '', children, radius, interactive = false, tone = 'regular', style, ...props }, forwardedRef) {
  const ref = useRef<HTMLElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  useLensRegistration(ref, false);
  return createElement(as, {
    ...props, ref,
    className: `lg-surface lg-panel glass-surface ${className}`.trim(),
    'data-glass': 'panel',
    'data-lg-lens': 'panel',
    'data-glass-source': 'lens-native',
    'data-glass-tone': tone,
    'data-glass-interactive': interactive || undefined,
    style: { ...(radius === undefined ? {} : { borderRadius: `${radius}px` }), ...style } as CSSProperties
  }, children);
});

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton({ className = '', children, radius, interactive = true, tone = 'regular', style, type = 'button', ...props }, forwardedRef) {
  const ref = useRef<HTMLButtonElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const press = interactive && !props.disabled;
  useLensRegistration(ref, press);
  return <button {...props} ref={ref} type={type} className={`lg-surface lg-button glass-button ${className}`.trim()} data-glass="button" data-lg-lens="button" data-lg-drag={press ? 'press' : undefined} data-lg-sound="select" data-glass-source="lens-native" data-glass-tone={tone} data-variant={/\bstudio-primary\b|\bprefs-button-primary\b/.test(className) ? 'success' : undefined} style={{ ...(radius === undefined ? {} : { borderRadius: `${radius}px` }), ...style } as CSSProperties}>
    {children}
  </button>;
});
