// src/components/BottomSheet.jsx
// ============================================================================
// The one modal shell. Every modal in the app is a full-screen backdrop with a
// container that sits flush to the bottom edge on phones and centres itself on
// desktop — four files had hand-written their own copy of that, and the copies
// had drifted apart in ways nobody would have chosen deliberately:
//
//   • AddDropPlayerModal portalled to <body>, with a comment explaining that a
//     fixed overlay rendered inside PullToRefresh's transformed wrapper gets
//     re-based onto that wrapper and breaks. The other three did not portal,
//     and two of them render inside exactly that wrapper.
//   • Three closed when you tapped the backdrop; AddDropPlayerModal did not.
//   • AccountModal and UserSettingsModal each shipped a byte-identical inline
//     <style> tag defining the same two keyframes, in a codebase whose
//     stylesheet header says runtime style injection was consolidated away.
//   • The backdrop was rgba(4,9,22,0.86) in two files and rgba(5,10,25,0.85)
//     in the other two — the same black, typed twice.
//
// Two variants, because there genuinely are two kinds of modal here:
//
//   sheet — identity and settings (Account, Notifications). Soft 22px corners,
//           gradient fill, drag handle, tap-outside-to-dismiss. Reading, not
//           filling in.
//   panel — task forms (Add/Drop, Add Transaction). Tighter 12px corners, flat
//           fill, an accent stripe along the top edge, fixed height on mobile
//           so a long list scrolls inside rather than growing the sheet. These
//           do NOT dismiss on backdrop tap: they hold unsaved input, and a
//           stray tap costing a half-filled waiver claim is a worse outcome
//           than an extra tap on Cancel. Escape and the close button still work.
// ============================================================================

import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { colors, fonts, fontSize, white, black, scrim } from '../theme.js';
import { useModalBehavior } from '../utils/modalUtils';

const VARIANTS = {
  sheet: {
    dismissOnBackdrop: true,
    handle: true,
    animated: true,
    blur: 'blur(6px)',
    maxWidth: 440,
    radius: { mobile: '22px 22px 0 0', desktop: 18 },
    height: { mobile: undefined, maxMobile: '92vh', maxDesktop: '84vh' },
    surface: () => ({
      background: 'linear-gradient(180deg, #14233f 0%, #0f1b31 100%)',
      border: `1px solid ${white(0.07)}`,
      boxShadow: `0 -8px 40px ${black(0.5)}`,
    }),
  },
  panel: {
    dismissOnBackdrop: false,
    handle: false,
    animated: false,
    blur: 'blur(4px)',
    maxWidth: 480,
    radius: { mobile: '12px 12px 0 0', desktop: 10 },
    height: { mobile: '90vh', maxMobile: '90vh', maxDesktop: '82vh' },
    surface: (accent) => ({
      background: '#0f1d35',
      border: `1px solid ${colors.borderSubtle}`,
      // Accent lives as a thin top stripe rather than a heavy border all the
      // way round — same signal, lighter chrome.
      ...(accent ? { borderTop: `2px solid ${accent}` } : null),
    }),
  },
};

/**
 * @param {boolean}  isOpen
 * @param {Function} onClose
 * @param {'sheet'|'panel'} variant
 * @param {string}   [title]     sheet variant only — renders the shared header
 * @param {string}   [subtitle]  sheet variant only
 * @param {string}   [accent]    panel variant only — top stripe colour
 * @param {string}   [label]     accessible name when there is no visible title
 */
export const BottomSheet = ({
  isOpen,
  onClose,
  variant = 'sheet',
  title,
  subtitle,
  accent,
  label,
  children,
}) => {
  // Escape, body scroll lock, and a Tab focus trap scoped to the dialog. Called
  // before the early return so the hook order stays stable across open/closed
  // renders; the ref is populated by the time the effect runs on the open render.
  const dialogRef = useRef(null);
  useModalBehavior(isOpen, onClose, dialogRef);

  if (!isOpen) return null;

  const v = VARIANTS[variant] || VARIANTS.sheet;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const titleId = title ? 'sfgl-sheet-title' : undefined;

  // Always portalled to <body>. A position:fixed overlay rendered inside an
  // ancestor carrying a transform is positioned against that ancestor rather
  // than the viewport, and PullToRefresh wraps the whole app in exactly such a
  // transform. Only one of the four modals used to guard against this.
  return createPortal(
    <div
      onClick={v.dismissOnBackdrop ? onClose : undefined}
      style={{
        position: 'fixed', inset: 0,
        background: scrim(0.85),
        backdropFilter: v.blur, WebkitBackdropFilter: v.blur,
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: isMobile ? 0 : 16,
        zIndex: 60,
        animation: v.animated ? 'sfgl-sheet-fade 0.2s ease' : undefined,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : label}
        // -1 so the dialog can hold focus itself when it has no focusable
        // children yet (async content) without joining the Tab order.
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{
          ...v.surface(accent),
          borderRadius: isMobile ? v.radius.mobile : v.radius.desktop,
          width: '100%',
          maxWidth: isMobile ? '100%' : v.maxWidth,
          height: isMobile ? v.height.mobile : 'auto',
          maxHeight: isMobile ? v.height.maxMobile : v.height.maxDesktop,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          paddingBottom: isMobile ? 'env(safe-area-inset-bottom)' : 0,
          animation: v.animated ? 'sfgl-sheet-up 0.3s cubic-bezier(0.32,0.72,0,1)' : undefined,
        }}
      >
        {v.handle && isMobile && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, flexShrink: 0 }}>
            <div style={{ width: 40, height: 5, borderRadius: 3, background: white(0.18) }} />
          </div>
        )}

        {title !== undefined && (
          <div style={{
            padding: isMobile ? '10px 20px 10px' : '16px 20px 12px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, flexShrink: 0,
          }}>
            <div style={{ minWidth: 0 }}>
              <div id={titleId} style={{
                fontFamily: fonts.sans, fontSize: 18, fontWeight: 600,
                color: colors.textPrimary, letterSpacing: '0.2px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {title}
              </div>
              {subtitle && (
                <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textMuted, marginTop: 2 }}>
                  {subtitle}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                flexShrink: 0, width: 34, height: 34, borderRadius: '50%',
                background: white(0.06), border: 'none', cursor: 'pointer',
                color: colors.textSecondary,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <X style={{ width: 18, height: 18 }} />
            </button>
          </div>
        )}

        {children}
      </div>
    </div>,
    document.body,
  );
};

/**
 * The scrollable body of a sheet. Separate from BottomSheet so panel-variant
 * modals — which supply their own header, body and footer as flex children —
 * are not forced into a single scroll region.
 */
export const SheetBody = ({ children, style }) => (
  <div
    className="sfgl-modal-scroll"
    style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px', WebkitOverflowScrolling: 'touch', ...style }}
  >
    {children}
  </div>
);

export default BottomSheet;
