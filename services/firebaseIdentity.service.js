import axios from 'axios';

const FIREBASE_LOOKUP_ENDPOINT = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

export const verifyFirebaseIdToken = async (idToken, firebaseApiKeyOverride = "") => {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Firebase ID token is required.');
  }

  const firebaseApiKey =
    firebaseApiKeyOverride || process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_APIKEY;

  if (!firebaseApiKey) {
    throw new Error('FIREBASE_API_KEY is not configured on server.');
  }

  try {
    const response = await axios.post(
      `${FIREBASE_LOOKUP_ENDPOINT}?key=${firebaseApiKey}`,
      { idToken },
      { timeout: 10000 }
    );

    const profile = response?.data?.users?.[0];

    if (!profile?.localId || !profile?.email) {
      throw new Error('Firebase user profile is incomplete.');
    }

    return {
      uid: profile.localId,
      email: profile.email,
      name: profile.displayName || profile.email.split('@')[0],
      picture: profile.photoUrl || '',
      emailVerified: Boolean(profile.emailVerified)
    };
  } catch (error) {
    const firebaseMessage =
      error?.response?.data?.error?.message || error?.message || 'Failed to verify Firebase token.';
    throw new Error(firebaseMessage);
  }
};
