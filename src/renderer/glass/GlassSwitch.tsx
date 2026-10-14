import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createSwitch, type SwitchHandle } from '../vendor/lens/switch.js';
import { useGlassCapability } from './capabilities';
import {createPortal} from 'react-dom';
import {RdevMaterial} from './RdevMaterial';

export type GlassSwitchProps = {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  style?: CSSProperties;
};

/** Empty React host; Lens owns one native button and its matching Jelly thumb. */
export function GlassSwitch({ className = '', style, ...props }: GlassSwitchProps): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null);
  const control = useRef<SwitchHandle | undefined>(undefined);
  const [materialHost,setMaterialHost]=useState<HTMLElement|null>(null);
  const latest = useRef(props); latest.current = props;
  const [revision, reconcile] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const glass = useGlassCapability();

  useLayoutEffect(() => {
    const root = host.current;
    if (!root) return;
    const instance = createSwitch({ ...latest.current, onChange: checked => {
      latest.current.onChange(checked);
      // A parent that declines a change still owns the model. A successful
      // acknowledgement matches instance.value and leaves the release spring.
      reconcile(current => current + 1);
    } });
    control.current = instance; root.append(instance.element);
    setMaterialHost(instance.element.querySelector('.lg-switch-thumb'));
    const domOverlay = Boolean(root.closest('[role="dialog"], [role="menu"]'));
    setOverlay(domOverlay);
    if (domOverlay) {
      instance.element.dataset.lgDomOverlay = 'true';
      instance.element.querySelector('.lg-switch-track')?.removeAttribute('data-glass');
      // Keep data-glass=thumb: the shared runtime locates its spring by this key.
    }
    return () => { control.current = undefined; instance.destroy(); instance.element.remove(); };
  }, []);

  useLayoutEffect(() => { control.current?.update({ label: props.label, disabled: props.disabled ?? false }); }, [props.label, props.disabled]);
  useLayoutEffect(() => {
    if (control.current && control.current.value !== props.checked) control.current.setValue(props.checked, { force: true, snap: true, cancel: true });
  }, [props.checked, revision]);

  const mode = overlay && glass.enabled ? 'frosted' : glass.mode;
  return <span ref={host} className={`glass-switch ${className}`.trim()} style={style} data-glass-switch-host data-glass-mode={mode} data-glass-source={mode === 'optical' ? 'rdev-liquid-glass-react' : undefined}>{materialHost&&mode==='optical'?createPortal(<RdevMaterial owner="switch"/>,materialHost):null}</span>;
}

export default GlassSwitch;
