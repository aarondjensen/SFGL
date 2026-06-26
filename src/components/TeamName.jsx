// src/components/TeamName.jsx
// ============================================================================
// Single source of truth for how a team's name is displayed across every tab.
//
// Shows the full team name normally, and collapses to the canonical
// abbreviation (getTeamAbbreviation) when the layout width is tight — small
// phones, split-screen, and especially iOS Display Zoom, which shrinks the CSS
// layout viewport (a zoomed iPhone reports ~320pt instead of ~375pt). At that
// width the fixed-width columns in tables like Standings starve the flexible
// name column, so a full name truncates to a single character; the abbreviation
// fits cleanly instead.
//
// MECHANISM: pure CSS show/hide — identical to the .sfgl-tab-label pattern in
// app-global.css. Both labels are rendered; a media query reveals exactly one.
// No JS, no resize listener, no re-render. The matching rules live in
// app-global.css under "Responsive team-name display".
//
// USAGE: replace a bare `{team.name}` text node with <TeamName name={team.name} />.
// Keep whatever styled wrapper already surrounds it — the two inner spans
// inherit its font/color. Pass `style`/`className` only if you need per-site
// tweaks (the abbreviation is forced nowrap by the global rule regardless).
// ============================================================================

import React from 'react';
import { getTeamAbbreviation } from '../utils';

export const TeamName = ({ name, className = '', style }) => {
  if (!name) return null;
  return (
    <>
      <span className={`sfgl-team-full ${className}`.trim()} style={style}>{name}</span>
      <span className={`sfgl-team-abbr ${className}`.trim()} style={style}>{getTeamAbbreviation(name)}</span>
    </>
  );
};

export default TeamName;
