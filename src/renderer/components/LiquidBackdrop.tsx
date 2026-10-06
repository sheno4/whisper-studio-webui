interface LiquidBackdropProps {
  wallpaperUrl?: string;
}

function LiquidBackdrop({ wallpaperUrl }: LiquidBackdropProps): React.JSX.Element {
  return (
    <div className="liquid-backdrop" aria-hidden="true">
      {wallpaperUrl ? <div className="wallpaper-layer" style={{ backgroundImage: `url("${wallpaperUrl}")` }} /> : null}
      <div className="ambient-orb ambient-orb-violet" />
      <div className="ambient-orb ambient-orb-cyan" />
      <div className="ambient-orb ambient-orb-blue" />
      <div className="grain-layer" />
    </div>
  );
}

export default LiquidBackdrop;
