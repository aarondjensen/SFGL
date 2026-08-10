// src/utils/a11y.js
// ============================================================================
// Keyboard affordances for elements that are clickable but are not <button>.
//
// The app has ~15 rows that respond to a click while being plain <div>s: roster
// entries, player-search results, the drop picker, the tournament rows that
// expand. A pointer reaches all of them; a keyboard reaches none. They are also
// invisible to a screen reader, which announces them as ordinary text because
// nothing says otherwise.
//
// Rewriting each as a <button> is not free here: several are flex rows several
// hundred pixels wide containing images, badges and their own nested buttons,
// and a <button> cannot legally contain a <button>. The fix that works for all
// of them is the ARIA button pattern — role, a tab stop, and Enter/Space — and
// this is the one implementation of it, so the rows cannot drift apart the way
// the four hand-written modal shells did.
//
// Usage:
//   <div {...activatable(() => select(p), { selected: isSelected })}> … </div>
//
// The returned object includes onClick, so it REPLACES the element's own
// onClick — spread it instead of writing one, and put the spread before any
// prop you mean to override.
// ============================================================================

// A key event that started inside a real control nested in the row (the × on a
// headshot, an inline Edit button) belongs to that control. Without this guard,
// pressing Enter on the nested button fires the button AND bubbles up to the
// row, so "remove this player" would also "select this player".
const fromNestedControl = (e) =>
  e.target !== e.currentTarget &&
  !!e.target.closest?.('button, a[href], input, select, textarea, [role="button"]') &&
  e.target.closest('button, a[href], input, select, textarea, [role="button"]') !== e.currentTarget;

/**
 * Props that make a non-button element behave like a button for a keyboard and
 * announce itself like one to assistive tech.
 *
 * @param {Function} onActivate            click / Enter / Space handler
 * @param {object}   [opts]
 * @param {boolean}  [opts.disabled]       announce as disabled and drop the tab stop
 * @param {boolean}  [opts.selected]       renders aria-pressed (toggle semantics)
 * @param {boolean}  [opts.expanded]       renders aria-expanded (disclosure semantics)
 * @param {string}   [opts.label]          accessible name when the text alone is not one
 * @param {string}   [opts.role='button']
 */
export function activatable(onActivate, opts = {}) {
  const { disabled = false, selected, expanded, label, role = 'button' } = opts;

  const props = { role };
  if (label !== undefined)    props['aria-label']    = label;
  if (selected !== undefined) props['aria-pressed']  = !!selected;
  if (expanded !== undefined) props['aria-expanded'] = !!expanded;

  // No tab stop for a row that cannot be acted on — a keyboard user tabbing
  // through 200 unavailable players to reach the one they can add is worse
  // than not reaching them at all. aria-disabled still announces why.
  if (disabled || typeof onActivate !== 'function') {
    props['aria-disabled'] = true;
    return props;
  }

  props.tabIndex = 0;
  props.onClick = onActivate;
  props.onKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (fromNestedControl(e)) return;
    // Space scrolls the page by default, and a row that scrolls the list out
    // from under you as it selects is unusable.
    e.preventDefault();
    onActivate(e);
  };
  return props;
}

export default activatable;
