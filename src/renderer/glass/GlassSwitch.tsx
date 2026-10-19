import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { createComponent, type ValueHandle } from '../vendor/lens-native/index.js';
import { releaseLensRoot, scheduleLensMount } from '../lens/Runtime';

export type GlassSwitchProps = {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  style?: CSSProperties;
};

/** The original factory owns the semantic switch and thumb. Its only spring
 * is registered with the same stage as every other Lens component. */
export function GlassSwitch({ className = '', style, ...props }: GlassSwitchProps): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null);
  const control = useRef<ValueHandle<boolean> | null>(null);
  const latest = useRef(props); latest.current = props;
  useLayoutEffect(() => {
    const root = host.current;
    if (!root) return;
    const instance = createComponent('switch', {
      label: latest.current.label, checked: latest.current.checked,
      onChange: checked => {
        const button = instance.element as HTMLButtonElement;
        if (button.matches(':disabled')) { instance.setValue(latest.current.checked); return; }
        latest.current.onChange(checked);
        queueMicrotask(() => {
          if (control.current === instance && instance.value !== latest.current.checked) instance.setValue(latest.current.checked);
        });
      }
    });
    (instance.element as HTMLButtonElement).disabled = Boolean(latest.current.disabled);
    control.current = instance; root.append(instance.element); scheduleLensMount(instance.element);
    return () => { control.current = null; releaseLensRoot(instance.element); instance.destroy(); instance.element.remove(); };
  }, []);
  useLayoutEffect(() => {
    const instance = control.current;
    if (!instance) return;
    instance.element.setAttribute('aria-label', props.label);
    (instance.element as HTMLButtonElement).disabled = Boolean(props.disabled);
    if (instance.value !== props.checked) instance.setValue(props.checked);
  }, [props.label, props.checked, props.disabled]);
  return <span ref={host} className={`glass-switch ${className}`.trim()} style={style} data-glass-switch-host data-glass-source="lens-native" />;
}

export default GlassSwitch;
