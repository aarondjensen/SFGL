// src/api/authApi.js
// ============================================================================
// Authentication + team-claim layer (Phase 2 of the auth migration).
//
// Replaces the legacy name/password system (managerAuthApi) with Firebase
// Authentication. Identity is the immutable Firebase UID — email-agnostic, so
// a manager's login account and their results-email are fully independent
// (an Apple "Hide My Email" relay address never has to match anything).
//
// Data model — one doc per team:
//   team_claims/{teamId} = { uid, claimedAt, notifyEmail }
//     • self-claim       — a signed-in user with no team claims an UNclaimed team
//     • commish reassign — commissioner overwrites uid on any team
//     • notifyEmail      — the owning manager's chosen results-email (optional);
//                          cron prefers this over settings.managerEmails
//
// Commissioner authority comes from a custom claim (token.commissioner === true),
// NOT from any client-writable flag. It is stamped once via the Admin SDK
// (api/cron.js), so flipping client state can't grant admin once the Firestore
// rules are locked in Phase 3.
// ============================================================================

import {
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signOut,
  onIdTokenChanged,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  collection,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { auth, db } from './_init';

const CLAIMS = 'team_claims';

// ── Providers ────────────────────────────────────────────────────────────────
// Web popup flow. The native Capacitor build (Phase 4) swaps these calls for
// the native @capacitor-firebase/authentication sheets; everything else calls
// signInWithGoogle()/signInWithApple() and doesn't care which path ran.
const googleProvider = new GoogleAuthProvider();
const appleProvider = new OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

export async function signInWithGoogle() {
  await signInWithPopup(auth, googleProvider);
}

export async function signInWithApple() {
  await signInWithPopup(auth, appleProvider);
}

export async function signOutUser() {
  await signOut(auth);
}

// ── Auth state ───────────────────────────────────────────────────────────────
// Fires on sign-in/out AND whenever the ID token refreshes, so a freshly
// stamped commissioner claim is picked up without a full reload. The callback
// receives { user, isCommissioner }; user is null when signed out.
export function watchAuth(cb) {
  return onIdTokenChanged(auth, async (user) => {
    if (!user) {
      cb({ user: null, isCommissioner: false });
      return;
    }
    let isCommissioner = false;
    try {
      const token = await user.getIdTokenResult();
      isCommissioner = token.claims?.commissioner === true;
    } catch {
      // Token read failed — default to non-commissioner (fail closed).
    }
    cb({ user, isCommissioner });
  });
}

// Force-refresh the current user's token. Call right after the commissioner
// claim is stamped so the new claim takes effect without a reload.
export async function refreshToken() {
  if (auth.currentUser) await auth.currentUser.getIdToken(true);
}

// ── Team claims ──────────────────────────────────────────────────────────────
// Realtime map of teamId → { uid, claimedAt, notifyEmail }.
export function subscribeClaims(cb) {
  return onSnapshot(
    collection(db, CLAIMS),
    (snap) => {
      const map = {};
      snap.forEach((d) => { map[d.id] = d.data(); });
      cb(map);
    },
    (e) => console.error('[authApi] subscribeClaims:', e),
  );
}

// Which team (if any) the given uid owns, derived from a claims map.
export function teamIdForUid(uid, claims) {
  if (!uid || !claims) return null;
  const hit = Object.entries(claims).find(([, c]) => c?.uid === uid);
  return hit ? hit[0] : null;
}

// Self-claim: bind my uid to an UNclaimed team. Refuses if the team is already
// owned by someone else — in that case the commissioner must reassign it.
export async function claimTeam(teamId, uid, email = null, displayName = null) {
  const ref = doc(db, CLAIMS, teamId);
  const snap = await getDoc(ref);
  const existing = snap.exists() ? snap.data()?.uid : null;
  if (existing && existing !== uid) {
    throw new Error('That team is already claimed. Ask the commissioner to reassign it.');
  }
  // Persist email/displayName alongside the uid so the commissioner's Managers
  // panel can show a human-readable owner instead of an opaque uid. These are
  // self-reported by the signing-in account and only written on self-claim.
  await setDoc(ref, {
    uid,
    email: email || null,
    displayName: displayName || null,
    claimedAt: serverTimestamp(),
  }, { merge: true });
}

// Commissioner reassign: force a team's owner uid. Pass uid = null to release
// the team back to unclaimed.
export async function reassignTeam(teamId, uid) {
  await setDoc(
    doc(db, CLAIMS, teamId),
    { uid: uid || null, email: null, displayName: null, claimedAt: serverTimestamp() },
    { merge: true },
  );
}

// Set the results-email for a team. Called by the owning manager for their own
// team, or by the commissioner for any team. Empty string clears it (cron then
// falls back to settings.managerEmails).
// Read a team's current results-email (used by the manager-facing settings UI
// to prefill the field). Returns '' when none is set.
export async function getNotifyEmail(teamId) {
  try {
    const snap = await getDoc(doc(db, CLAIMS, teamId));
    return (snap.exists() && snap.data()?.notifyEmail) || '';
  } catch {
    return '';
  }
}

export async function setNotifyEmail(teamId, email) {
  await setDoc(
    doc(db, CLAIMS, teamId),
    { notifyEmail: (email || '').trim() || null },
    { merge: true },
  );
}
