// src/pages/rosters/helpers.js
// ============================================================================
// Shared helpers used by the rosters subcomponents (LineupHeadshot, etc.) AND
// by the main RostersView. Extracting these here lets the subcomponents stay
// pure imports without prop-drilling — both ends just import what they need.
//
// Created in Wave J Part 1 alongside the first round of RostersView
// subcomponent extractions.
// ============================================================================

/**
 * Border color for a player's headshot, derived from their roster type.
 *   • limited   → gold (the gold-star players)
 *   • unlimited → blue (premium/unlimited tier)
 *   • regular   → white (default)
 */
export const playerBorderColor = (player) =>
  player.limited   ? 'rgba(245,197,24,0.9)' :
  player.unlimited ? 'rgba(100,140,220,0.9)' :
  'rgba(255,255,255,0.85)';
