interface LiquidBackdropProps {
  wallpaperUrl?: string;
}

function LiquidBackdrop({ wallpaperUrl }: LiquidBackdropProps): React.JSX.Element {
  return (
    <div className="liquid-backdrop" aria-hidden="true">
      {wallpaperUrl ? <div className="wallpaper-layer" style={{ backgroundImage: `url("${wallpaperUrl}")` }} /> : null}
      <div className="landscape-light" />
    </div>
  );
}

export default LiquidBackdrop;
