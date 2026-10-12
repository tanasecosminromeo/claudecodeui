import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { SideQuestionEntry, SideQuestionUpdatedEvent } from '@/shared/types.js';

/**
 * Sends one `/btw` entry's new state to every connected client, so every open
 * side panel updates without polling. Sibling of `broadcastSessionUpserted`.
 */
export function broadcastSideQuestionUpdated(sessionId: string, entry: SideQuestionEntry): void {
  const event: SideQuestionUpdatedEvent = { kind: 'side_question_updated', sessionId, entry };
  const payload = JSON.stringify(event);

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}
