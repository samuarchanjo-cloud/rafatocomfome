const storageKey = "rafa-checkout-attempt-v1";

export function readCheckoutAttempt(storage) {
  try {
    const attempt = JSON.parse(storage.getItem(storageKey));
    return attempt?.id && attempt?.secret ? attempt : null;
  } catch {
    return null;
  }
}

export function writeCheckoutAttempt(storage, attempt) {
  if (attempt) storage.setItem(storageKey, JSON.stringify(attempt));
  else storage.removeItem(storageKey);
}

export function createCheckoutAttempt(actorId, payload) {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id: crypto.randomUUID(), secret, actorId, payload };
}

export function attemptCredential({ id, secret }) {
  return { id, secret };
}

export function completedAttempt(attempt) {
  const { payload, ...credential } = attempt;
  return credential;
}
