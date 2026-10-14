import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {createPortal} from 'react-dom';
import {RdevMaterial} from './RdevMaterial';
import { createSegmentedControl, type SegmentedHandle } from '../vendor/lens/segmented.js';
import { useGlassCapability } from './capabilities';

export type GlassSegmentOption<Value extends string = string> = {
  value: Value;
  label: string;
  disabled?: boolean;
  badge?: string | number;
};
export type GlassSegmentedControlProps<Value extends string = string> = {
  label: string;
  options: GlassSegmentOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  disabled?: boolean;
  panelIds?: Partial<Record<Value, string>>;
  className?: string;
  style?: CSSProperties;
};

/** React owns this empty host and controlled value; the original Lens tabs
 * factory owns every tab and the shared Jelly segment body owns its gesture. */
export function GlassSegmentedControl<Value extends string>({ className = '', style, ...props }: GlassSegmentedControlProps<Value>) {
  const host = useRef<HTMLDivElement>(null);
  const control = useRef<SegmentedHandle | undefined>(undefined);
  const [materialHost,setMaterialHost]=useState<HTMLElement|null>(null);
  const latest = useRef(props); latest.current = props;
  const glass = useGlassCapability();
  const optionKeys = JSON.stringify(props.options.map(option => option.value));

  useLayoutEffect(() => {
    if (!host.current) return;
    const current = latest.current;
    const instance = createSegmentedControl({
      ...current,
      panelIds: current.panelIds as Record<string, string> | undefined,
      onChange: value => latest.current.onChange(value as Value)
    });
    control.current = instance;
    host.current.append(instance.element);
    setMaterialHost(instance.element.querySelector('.lg-segment-indicator'));
    return () => {
      control.current = undefined;
      instance.destroy(); instance.element.remove();
    };
  }, [optionKeys]);

  useLayoutEffect(() => {
    control.current?.update({ label: props.label, options: props.options, disabled: props.disabled, panelIds: props.panelIds as Record<string, string> | undefined });
  }, [props.label, props.options, props.disabled, props.panelIds]);
  useLayoutEffect(() => {
    // An emitted drag commit is already aligned by Lens. Acknowledging it must
    // keep the release spring; only an actual external change interrupts it.
    if (control.current?.value !== props.value) control.current?.setValue(props.value, {force: true, snap: true, cancel: true});
  }, [props.value, optionKeys]);

  return <div ref={host} className={`glass-segmented-control ${className}`.trim()} style={style} data-glass-segment-host data-glass-mode={glass.mode} data-glass-source={glass.mode === 'optical' ? 'rdev-liquid-glass-react' : undefined}>{materialHost&&glass.mode==='optical'?createPortal(<RdevMaterial owner="segment"/>,materialHost):null}</div>;
}

export default GlassSegmentedControl;
