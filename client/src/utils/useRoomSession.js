import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { RoomSessionController } from './roomSession.js';
import { SERVER_URL, createRoomConnection, sessionStore } from './socket.js';
import { STORAGE_KEYS } from './session.js';
import { playGavel, playBidPing, playSoldFanfare, playUnsold } from './audio.js';

const sounds = { gavel: playGavel, bid: playBidPing, sold: playSoldFanfare, unsold: playUnsold };

let singleton = null;
function getController() {
  if (!singleton) {
    singleton = new RoomSessionController({
      serverUrl: SERVER_URL,
      store: sessionStore,
      createConnection: createRoomConnection,
      onSound: (k) => { try { sounds[k]?.(); } catch { /* audio blocked */ } }
    });
  }
  return singleton;
}

// One controller per tab. Restores only this tab's room, reacts to sign-out in other tabs.
export function useRoomSession() {
  const controller = useMemo(() => getController(), []);
  const state = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.getState()
  );

  useEffect(() => {
    controller.restore();
    const onStorage = (e) => {
      if (e.key === STORAGE_KEYS.token || e.key === null) controller.identityChangedElsewhere();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [controller]);

  return { state, controller, identity: controller.identity };
}
