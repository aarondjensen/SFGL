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
  signInWithCredential,
  signInAnonymously,
  linkWithCredential,
  linkWithPopup,
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
import { Capacitor } from '@capacitor/core';

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
  if (Capacitor.isNativePlatform()) {
    // Native iOS/Android: the web popup can't complete inside a WebView, so
    // run the OS-native Google sheet via @capacitor-firebase/authentication,
    // then finish in the JS SDK with the returned credential. Config has
    // skipNativeAuth:true, so the plugin only fetches the credential and the
    // JS SDK stays the single source of truth (watchAuth / onIdTokenChanged).
    const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
    const result = await FirebaseAuthentication.signInWithGoogle();
    const credential = GoogleAuthProvider.credential(result.credential?.idToken);
    await signInWithCredential(auth, credential);
    return;
  }
  await signInWithPopup(auth, googleProvider);
}

export async function signInWithApple() {
  if (Capacitor.isNativePlatform()) {
    const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
    const result = await FirebaseAuthentication.signInWithApple();
    // Apple rejects the token unless the raw nonce the plugin generated is
    // passed back when building the JS-SDK credential.
    const provider = new OAuthProvider('apple.com');
    const credential = provider.credential({
      idToken: result.credential?.idToken,
      rawNonce: result.credential?.nonce,
    });
    await signInWithCredential(auth, credential);
    return;
  }
  await signInWithPopup(auth, appleProvider);
}

// ── Guest (anonymous) sign-in ────────────────────────────────────────────────
// Exists for app-store review and tester runs: Google Play and Apple both
// require a way in for a reviewer who has no league team, and the 12-tester
// closed-track requirement means handing the app to people who will never own
// one either. Everything below the gate needs a signed-in user, so "no login"
// was not an option — a real Firebase account with no team is.
//
// A guest is an ANONYMOUS Firebase user, and that is the whole permission
// model:
//
//   • uid is real, so App Check, the rules and the SDK all behave normally.
//   • It matches no team_claims document, so teamIdForUid returns null and the
//     app renders with no owned team — every edit affordance in the views keys
//     off loggedInTeamId, so they are all off.
//   • firestore.rules denies WRITES to sign_in_provider == 'anonymous' (see
//     isMember there). The read-only-ness is enforced server-side; the UI just
//     agrees with it.
//
// No popup and no native plugin — anonymous sign-in is a plain token exchange,
// so this one path works identically in the browser and in the Capacitor
// WebView. Requires Anonymous to be enabled in Firebase console →
// Authentication → Sign-in method.
export async function signInAsGuest() {
  await signInAnonymously(auth);
}

// True when the given user (default: the current one) is a guest. Callers pass
// the user from watchAuth rather than reading auth.currentUser, so the answer
// changes in the same render as the rest of the auth state.
export function isGuestUser(user = auth.currentUser) {
  return user?.isAnonymous === true;
}

export async function signOutUser() {
  // On native, also clear the plugin session so the next sign-in shows the
  // account picker instead of silently reusing the last account. Swallowed
  // so a native hiccup can never block the JS SDK sign-out.
  if (Capacitor.isNativePlatform()) {
    try {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      await FirebaseAuthentication.signOut();
    } catch (e) {
      console.warn('[authApi] native signOut failed:', e?.message || e);
    }
  }
  await signOut(auth);
}

// ── Account linking ──────────────────────────────────────────────────────
// Attach a SECOND provider to the already-signed-in user so Google + Apple
// resolve to ONE Firebase uid (and therefore one team). Apple's Hide-My-Email
// means the two identities never auto-match by email, so linking is an explicit
// action the signed-in user takes once. Mirrors the sign-in paths: native uses
// the plugin to fetch a credential, then links it in the JS SDK.
function friendlyLinkError(e, label) {
  const code = e?.code;
  if (code === 'auth/provider-already-linked') return new Error(`Your ${label} account is already linked.`);
  if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use')
    return new Error(`That ${label} account is already tied to a different SFGL login. The commissioner must remove that login first, then link.`);
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request')
    return new Error('Linking cancelled.');
  return new Error(e?.message || `Could not link your ${label} account.`);
}

export async function linkAppleAccount() {
  const user = auth.currentUser;
  if (!user) throw new Error('Please sign in first, then link your Apple account.');
  try {
    if (Capacitor.isNativePlatform()) {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const result = await FirebaseAuthentication.signInWithApple();
      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({
        idToken: result.credential?.idToken,
        rawNonce: result.credential?.nonce,
      });
      await linkWithCredential(user, credential);
      return;
    }
    await linkWithPopup(user, appleProvider);
  } catch (e) {
    throw friendlyLinkError(e, 'Apple');
  }
}

export async function linkGoogleAccount() {
  const user = auth.currentUser;
  if (!user) throw new Error('Please sign in first, then link your Google account.');
  try {
    if (Capacitor.isNativePlatform()) {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const result = await FirebaseAuthentication.signInWithGoogle();
      const credential = GoogleAuthProvider.credential(result.credential?.idToken);
      await linkWithCredential(user, credential);
      return;
    }
    await linkWithPopup(user, googleProvider);
  } catch (e) {
    throw friendlyLinkError(e, 'Google');
  }
}

// Which providers are attached to the current user. Drives the settings UI.
export function getLinkedProviders() {
  const u = auth.currentUser;
  const ids = (u?.providerData || []).map((p) => p.providerId);
  return { google: ids.includes('google.com'), apple: ids.includes('apple.com') };
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
