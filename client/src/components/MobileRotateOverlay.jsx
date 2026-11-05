import React, { useState, useEffect } from 'react';
import { RotateCw, Smartphone } from 'lucide-react';

export default function MobileRotateOverlay() {
  const [isPortraitMobile, setIsPortraitMobile] = useState(false);

  useEffect(() => {
    const checkOrientation = () => {
      // Check if mobile device viewport (width < 768) and height > width (portrait)
      const isMobileSize = window.innerWidth < 768;
      const isPortrait = window.innerHeight > window.innerWidth;
      setIsPortraitMobile(isMobileSize && isPortrait);
    };

    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);

    return () => {
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
  }, []);

  if (!isPortraitMobile) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-gradient-to-b from-[#050b25] via-[#04081c] to-[#02040e] flex flex-col items-center justify-center p-6 text-center select-none backdrop-blur-xl">
      {/* Background radial glow */}
      <div className="absolute w-72 h-72 rounded-full bg-amber-500/15 blur-3xl pointer-events-none" />

      {/* Rotating Phone Graphic */}
      <div className="relative mb-6">
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-amber-400 to-yellow-500 p-0.5 shadow-2xl shadow-amber-500/30 flex items-center justify-center">
          <div className="w-full h-full bg-slate-950 rounded-2xl flex items-center justify-center relative">
            <Smartphone className="w-10 h-10 text-amber-400 animate-pulse" />
            <RotateCw className="w-6 h-6 text-amber-300 absolute -top-2 -right-2 animate-spin text-amber-400" style={{ animationDuration: '4s' }} />
          </div>
        </div>
      </div>

      {/* Headline */}
      <h2 className="text-xl font-black text-white tracking-wide uppercase mb-2">
        ROTATE YOUR DEVICE
      </h2>

      {/* Required Text */}
      <p className="text-sm font-medium text-slate-300 max-w-xs leading-relaxed">
        Please rotate your device to landscape mode for the best auction experience.
      </p>

      {/* Visual orientation preview hint */}
      <div className="mt-8 flex items-center gap-3 text-xs text-amber-400 font-bold bg-amber-500/10 border border-amber-500/30 px-4 py-2 rounded-full">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
        <span>Landscape Recommended</span>
      </div>
    </div>
  );
}
