import { createElement, forwardRef, Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type RefObject } from 'react';
import { useGlassCapability } from './capabilities';
import { createLensMaps, type LensMaps } from './lens-map';
import { spectralSamples, type CornerRadii } from './lens-math';
import { useGlassFeedback } from './useGlassFeedback';

type OpticalProps = {
  radius?: number;
  refractionHeight?: number;
  refractionAmount?: number;
  dispersion?: boolean;
  interactive?: boolean;
  tone?: 'clear' | 'regular' | 'strong';
};
export type GlassSurfaceProps = HTMLAttributes<HTMLElement> & OpticalProps & { as?: 'div' | 'section' | 'nav' | 'header' | 'aside' | 'footer' };
export type GlassButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & OpticalProps;
type OpticalState = { maps: LensMaps; width: number; height: number };

function cornerRadius(value: string, width: number, height: number): number {
  return value.includes('%') ? Number.parseFloat(value) / 100 * Math.min(width, height) : Number.parseFloat(value) || 0;
}

function useLens(ref: RefObject<HTMLElement | null>, amount: number, height: number, dispersion: boolean, radius: number | undefined) {
  const capability = useGlassCapability();
  const [optics, setOptics] = useState<OpticalState>();
  const [encodingFailed, setEncodingFailed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || capability.mode !== 'optical') { setOptics(undefined); return; }
    let frame = 0;
    let previousKey = '';
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // The absolute backdrop occupies the padding box, excluding the outer
        // border. Use its actual filter coordinate space, not the host's box.
        const backdrop = element.querySelector<HTMLElement>('.glass-surface__backdrop') ?? element;
        const width = backdrop.offsetWidth;
        const elementHeight = backdrop.offsetHeight;
        if (!element.isConnected || width < 2 || elementHeight < 2) { previousKey = ''; setOptics(undefined); return; }
        const style = getComputedStyle(backdrop);
        const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map((value) => cornerRadius(value, width, elementHeight)) as unknown as CornerRadii;
        const key = [width, elementHeight, ...radii, window.devicePixelRatio, amount, height, dispersion].join(':');
        if (key === previousKey) return;
        previousKey = key;
        try {
          setOptics({ maps: createLensMaps({ width, height: elementHeight, radii, refractionAmount: amount, refractionHeight: height }, dispersion), width, height: elementHeight });
          setEncodingFailed(false);
        } catch { previousKey = ''; setEncodingFailed(true); setOptics(undefined); }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('resize', resize, { passive: true });
    resize();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); cancelAnimationFrame(frame); };
  }, [ref, capability.mode, amount, height, dispersion, radius]);
  return {
    optics,
    mode: capability.mode === 'solid' || encodingFailed ? 'solid' : optics ? 'optical' : 'pending',
    reason: encodingFailed ? 'map-encoding-unavailable' : capability.reason
  } as const;
}

export function LensDefinitions({ id, optics }: { id: string; optics: OpticalState }) {
  const { maps, width, height } = optics;
  const dispersed = maps.displacement.length > 1;
  return <svg className="glass-surface__definitions" width="0" height="0" aria-hidden="true" focusable="false">
    <defs><filter id={id} x="0" y="0" width={width} height={height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      {maps.displacement.map((href, index) => <Fragment key={index}>
        <feImage href={href} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result={`map-${index}`} />
        <feComponentTransfer in={`map-${index}`} result={`neutral-map-${index}`}>
          <feFuncR type="linear" slope="1" intercept={0.5 - 128 / 255} />
          <feFuncG type="linear" slope="1" intercept={0.5 - 128 / 255} />
        </feComponentTransfer>
        <feDisplacementMap in="SourceGraphic" in2={`neutral-map-${index}`} scale={maps.scale} xChannelSelector="R" yChannelSelector="G" result={`refracted-${index}`} />
        {/* The app has an opaque page backdrop. Keep branch alpha intact: scaling
            it here would also attenuate premultiplied RGB by another 1/7. */}
        {dispersed && <feColorMatrix in={`refracted-${index}`} type="matrix" values={`${spectralSamples[index].red} 0 0 0 0 0 ${spectralSamples[index].green} 0 0 0 0 0 ${spectralSamples[index].blue} 0 0 0 0 0 1 0`} result={`spectral-${index}`} />}
      </Fragment>)}
      {dispersed && spectralSamples.slice(1).map((_, offset) => <feComposite key={offset} in={offset === 0 ? 'spectral-0' : `sum-${offset}`} in2={`spectral-${offset + 1}`} operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result={`sum-${offset + 1}`} />)}
    </filter></defs>
  </svg>;
}

function OpticalLayers({ id, optics }: { id: string; optics?: OpticalState }) {
  return <>
    {optics && <LensDefinitions id={id} optics={optics} />}
    <span className="glass-surface__backdrop" aria-hidden="true" style={optics ? { backdropFilter: `url(#${id})`, WebkitBackdropFilter: `url(#${id})` } : undefined} />
    {optics && <>
      <span className="glass-surface__rim" data-glass-rim="left" aria-hidden="true" style={{ backgroundImage: `url("${optics.maps.highlight[0]}")` }} />
      <span className="glass-surface__rim" data-glass-rim="right" aria-hidden="true" style={{ backgroundImage: `url("${optics.maps.highlight[1]}")` }} />
    </>}
  </>;
}

export const GlassSurface = forwardRef<HTMLElement, GlassSurfaceProps>(function GlassSurface({ as = 'div', className = '', children, radius, refractionHeight = 12, refractionAmount = 20, dispersion = true, interactive = false, tone = 'regular', style, ...props }, forwardedRef) {
  const ref = useRef<HTMLElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const id = `glass-lens-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { optics, mode, reason } = useLens(ref, refractionAmount, refractionHeight, dispersion, radius);
  useGlassFeedback(ref, interactive);
  return createElement(as, {
    ...props, ref,
    className: `glass-surface ${className}`.trim(),
    'data-glass-mode': mode,
    'data-glass-source': mode === 'optical' ? 'live-dom' : undefined,
    'data-glass-fallback': mode === 'solid' ? reason : undefined,
    'data-glass-tone': tone,
    'data-glass-interactive': interactive || undefined,
    style: { ...(radius === undefined ? {} : { '--glass-radius': `${radius}px` }), ...style } as CSSProperties
  }, <><OpticalLayers id={id} optics={optics} /><span className="glass-surface__content">{children}</span></>);
});

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton({ className = '', children, radius = 999, refractionHeight = 8, refractionAmount = 14, dispersion = true, interactive = true, tone = 'regular', style, type = 'button', ...props }, forwardedRef) {
  const ref = useRef<HTMLButtonElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current!, []);
  const id = `glass-lens-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { optics, mode, reason } = useLens(ref, refractionAmount, refractionHeight, dispersion, radius);
  useGlassFeedback(ref, interactive && !props.disabled);
  return <button {...props} ref={ref} type={type} className={`glass-button glass-surface ${className}`.trim()} data-glass-mode={mode} data-glass-source={mode === 'optical' ? 'live-dom' : undefined} data-glass-fallback={mode === 'solid' ? reason : undefined} data-glass-tone={tone} data-glass-interactive={interactive || undefined} style={{ '--glass-radius': `${radius}px`, ...style } as CSSProperties}>
    <OpticalLayers id={id} optics={optics} />
    <span className="glass-surface__content glass-button__content">{children}</span>
  </button>;
});
