'use client';
import { useEffect, useRef } from 'react';
import createGlobe from 'cobe';

// A real 3D rotating "connected world" globe (cobe / WebGL) for the hero background:
// a dotted earth with glowing payment-hub markers and connection arcs, slowly spinning.
// Theme-aware; honours prefers-reduced-motion (renders once, no spin); decorative, so it
// simply stays blank if WebGL is unavailable.
export function GlobeBg() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let width = canvas.offsetWidth || 780;
    const onResize = () => {
      width = canvas.offsetWidth || 780;
      globe.update({ width: width * 2, height: width * 2 });
    };

    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 1 : 0;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let phi = 0;
    let raf = 0;

    const globe = createGlobe(canvas, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi: 0,
      theta: 0.3,
      dark,
      diffuse: 1.1,
      mapSamples: 16000,
      mapBrightness: dark ? 5.2 : 7.5,
      baseColor: dark ? [0.34, 0.42, 0.62] : [0.62, 0.7, 0.92],
      markerColor: [0.55, 0.42, 1],
      glowColor: dark ? [0.16, 0.2, 0.42] : [0.86, 0.9, 1],
      markers: [
        { location: [37.7749, -122.4194], size: 0.05 },
        { location: [40.7128, -74.006], size: 0.06 },
        { location: [51.5072, -0.1276], size: 0.05 },
        { location: [1.3521, 103.8198], size: 0.06 },
        { location: [35.6762, 139.6503], size: 0.05 },
        { location: [-23.5505, -46.6333], size: 0.04 },
        { location: [19.076, 72.8777], size: 0.05 },
        { location: [25.2048, 55.2708], size: 0.04 },
      ],
      arcs: [
        { from: [37.7749, -122.4194], to: [40.7128, -74.006] },
        { from: [40.7128, -74.006], to: [51.5072, -0.1276] },
        { from: [51.5072, -0.1276], to: [25.2048, 55.2708] },
        { from: [25.2048, 55.2708], to: [1.3521, 103.8198] },
        { from: [1.3521, 103.8198], to: [35.6762, 139.6503] },
      ],
      arcColor: [0.55, 0.42, 1],
      arcWidth: 0.35,
      arcHeight: 0.45,
    });

    window.addEventListener('resize', onResize);
    if (reduce) {
      globe.update({ phi: 0 });
    } else {
      const loop = () => {
        phi += 0.0042;
        globe.update({ phi });
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      globe.destroy();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div className="globe-bg" aria-hidden="true">
      <canvas
        ref={ref}
        style={{ width: '100%', height: '100%', aspectRatio: '1', contain: 'layout paint size' }}
      />
    </div>
  );
}
