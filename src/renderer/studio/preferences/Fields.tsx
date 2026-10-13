import type { ReactNode } from 'react';

export function PreferenceGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }): React.JSX.Element {
  return <section className="prefs-group"><header><h4>{title}</h4>{description ? <p>{description}</p> : null}</header><div className="prefs-group-content">{children}</div></section>;
}

export function PreferenceField({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }): React.JSX.Element {
  return <label className={`prefs-field${wide ? ' prefs-field-wide' : ''}`}><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

export function PreferenceToggle({ label, hint, checked, onChange, disabled = false }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }): React.JSX.Element {
  return <label className="prefs-toggle"><span><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</span><input aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} role="switch" type="checkbox" /></label>;
}
