import { useState, useEffect } from 'react';

// Is the viewport phone-width?
//
// 640px, matching every other place in the app that asks (BottomSheet,
// AddDropPlayerModal, RostersView's row treatment). It was declared three
// times before this — twice as a non-reactive `window.innerWidth < 640` read
// at render, which never updates on rotate, and once as this hook inside
// RostersView, where nothing else could reach it.
//
// Reactive on purpose: the commissioner's schedule editor swaps between a
// stacked card list and a table across this breakpoint, and a phone turned
// sideways has to land on the other one.
export const useIsMobile = (breakpoint = 640) => {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < breakpoint
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', handler);
    handler();
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);
  return isMobile;
};

export default useIsMobile;
