import {GlassSlider} from './GlassSlider';
import {getGlassIntensity,setGlassIntensity,saveGlassIntensity} from './material-intensity';

/** Browser-local live preference; changing it never dirties backend settings. */
export function GlassIntensity({disabled=false}:{disabled?:boolean}):React.JSX.Element {
  return <GlassSlider label="玻璃强度" defaultValue={Math.round(getGlassIntensity()*100)} min={0} max={100} step={1} disabled={disabled} formatValue={value=>`${Math.round(value)}%`} hint="即时调节玻璃的透镜与高光，仅保存在此浏览器。" onValueChange={value=>setGlassIntensity(value/100)} onValueCommit={saveGlassIntensity}/>;
}
