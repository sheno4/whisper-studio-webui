import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type RefObject } from 'react';
import { createLensSurface } from '../vendor/lens/internal/lens-surface.js';
import { useGlassCapability } from './capabilities';
import {RdevMaterial} from './RdevMaterial';

type MaterialProps = {
  radius?: number;
  interactive?: boolean;
  tone?: 'clear' | 'regular' | 'strong';
};
export type GlassSurfaceProps = Omit<HTMLAttributes<HTMLElement>, 'draggable'> & MaterialProps & {
  as?: 'div' | 'section' | 'nav' | 'header' | 'aside' | 'footer';
};
export type GlassButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & MaterialProps;

/** React owns semantic DOM and rdev material; Lens owns only the spring body. */
function useLensSurface(ref: RefObject<HTMLElement | null>, kind: 'panel' | 'small', motion: 'none' | 'press', className: string) {
  const capability = useGlassCapability();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const surface = createLensSurface({ element, kind, motion });
    return () => surface.destroy();
  }, [ref, kind, motion, className]);
  const compact=kind==='small'||/studio-header|studio-reading-tools/.test(className);
  return {
    ...capability,
    mode: !compact && capability.enabled ? 'frosted' : capability.mode,
    source: !capability.enabled ? undefined : 'rdev-liquid-glass-react',
    reason: !compact && capability.enabled ? 'large-surface-native-backdrop' : capability.reason
  } as const;
}

export const GlassSurface = forwardRef<HTMLElement, GlassSurfaceProps>(function GlassSurface({ as = 'div', className = '', children, radius, interactive = false, tone = 'regular', style, ...props }, forwardedRef) {
  const ref = useRef<HTMLElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  // Panels and title bars are stationary; only semantic controls manipulate.
  const motion = 'none';
  const glass = useLensSurface(ref, 'panel', motion, className);
  return createElement(as, {
    ...props, ref,
    className: `lg-surface glass-surface ${className}`.trim(),
    'data-glass': 'panel',
    'data-lg-lens': 'panel',
    'data-lg-drag': motion === 'none' ? undefined : motion,
    'data-glass-background-layer': glass.mode === 'frosted' || undefined,
    'data-glass-mode': glass.mode,
    'data-glass-source': glass.mode === 'optical' ? glass.source : undefined,
    'data-glass-fallback': glass.mode !== 'optical' ? glass.reason : undefined,
    'data-glass-tone': tone,
    'data-glass-interactive': interactive || undefined,
    style: { ...(radius === undefined ? {} : { '--glass-radius': `${radius}px` }), ...style } as CSSProperties
  }, <>{glass.mode==='optical'?<RdevMaterial owner="toolbar" radius={radius??24}/>:glass.mode==='frosted'?<span aria-hidden="true" className="glass-surface__frost"/>:null}<span className="glass-surface__content">{children}</span></>);
});

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton({ className = '', children, radius = 999, interactive = true, tone = 'regular', style, type = 'button', ...props }, forwardedRef) {
  const ref = useRef<HTMLButtonElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const motion = interactive && !props.disabled ? 'press' : 'none';
  const glass = useLensSurface(ref, 'small', motion, className);
  return <button {...props} ref={ref} type={type} className={`lg-surface glass-button glass-surface ${className}`.trim()} data-glass="small" data-lg-lens="small" data-lg-drag={motion === 'none' ? undefined : motion} data-glass-mode={glass.mode} data-glass-source={glass.mode === 'optical' ? glass.source : undefined} data-glass-fallback={glass.mode !== 'optical' ? glass.reason : undefined} data-glass-tone={tone} data-glass-interactive={interactive || undefined} style={{ '--glass-radius': `${radius}px`, ...style } as CSSProperties}>
    {glass.mode==='optical'?<RdevMaterial owner="button" radius={radius}/>:null}
    <span className="glass-surface__content glass-button__content">{children}</span>
  </button>;
});
