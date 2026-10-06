// Which browser tabs are "in use" (visible, with input in the last 2 minutes, as
// reported by the client). While any tab of a user is in use, web push waits:
// the in-app "needs attention" badge covers it.
export const PRESENCE_TTL_MS = 75 * 1000; // a sleeping laptop may never close its socket

const presence = new Map(); // socket -> { userId, active, at }

export function setClientPresence(socket, userId, active, now = Date.now()) {
  presence.set(socket, { userId: String(userId), active, at: now });
}

export function removeClientPresence(socket) {
  presence.delete(socket);
}

export function isUserActiveSomewhere(userId, now = Date.now()) {
  const id = String(userId);
  for (const p of presence.values()) {
    if (p.userId === id && p.active && now - p.at < PRESENCE_TTL_MS) return true;
  }
  return false;
}
