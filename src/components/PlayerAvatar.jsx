// src/components/PlayerAvatar.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The one player avatar.
//
// Every roster / lineup / search surface renders the same thing — a circular
// player photo that falls through a chain of CDNs to an initials avatar — and
// there were five near-copies of it, each of which had drifted on its own:
//
//   • RostersView roster row — a bordered <img> sized 30×30 inside a `display:
//     flex` button also sized 30×30, with no flexShrink and no box-sizing. The
//     border pushed the image's total width past the 30px line, so the flex
//     container squeezed it on the MAIN axis only. Width shrank, height did
//     not: the circle rendered as an OVAL, and how oval depended on the border
//     the row happened to be drawing (1px normally, 2px in the lineup, 3px
//     while editing).
//   • LineupHeadshot — same missing box-sizing. 44px + a 2px border painted a
//     48px circle in a slot the layout had reserved 44px for.
//   • The backup slot — the only one that clipped correctly.
//   • WaiverQueue / AddDropPlayerModal — no framing correction, so ESPN's
//     wide chest-up crop sat high in the circle.
//
// Anything that needs a badge or a button on top keeps its own positioned
// wrapper; this component owns the circle itself and nothing else.
//
// The wrapper clips (overflow: hidden) because the framing correction in
// headshotUtils is a transform, and a transform is NOT contained by the
// image's own border-radius.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getPlayerHeadshot,
  makeHeadshotErrorHandler,
  getHeadshotFrame,
} from '../utils/headshotUtils';

/**
 * @param {string}  name        player name — the key into the headshots map
 * @param {object}  headshots   the headshots map
 * @param {boolean} isLimited   gold initials fallback for limited-slot players
 * @param {number}  [size]      diameter in px. Omit to fill the parent (100%),
 *                              for callers that already own a sized wrapper.
 * @param {string}  [border]    CSS border shorthand. Included INSIDE `size`
 *                              via border-box, so changing border width can
 *                              never change the circle's footprint.
 * @param {object}  [style]     extra wrapper style (opacity, transition, …)
 * @param {object}  [imgStyle]  extra image style — escape hatch, rarely needed
 */
export const PlayerAvatar = ({
  name,
  headshots = {},
  isLimited = false,
  size,
  border = 'none',
  background = 'rgba(255,255,255,0.06)',
  style = {},
  imgStyle = {},
  alt = '',
  title,
}) => {
  const src = getPlayerHeadshot(name, headshots, isLimited);
  const dim = size === undefined ? '100%' : size;

  return (
    <span
      title={title}
      style={{
        display: 'block',
        width: dim,
        height: dim,
        // border-box is what keeps this a CIRCLE: the border is drawn inside
        // `size`, so the element's footprint is exactly `size` regardless of
        // border width, and a flex parent has nothing to squeeze.
        boxSizing: 'border-box',
        flexShrink: 0,
        borderRadius: '50%',
        border,
        background,
        overflow: 'hidden',
        ...style,
      }}
    >
      <img
        src={src}
        onError={makeHeadshotErrorHandler(name, headshots, isLimited)}
        alt={alt}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          ...getHeadshotFrame(src),
          ...imgStyle,
        }}
      />
    </span>
  );
};
