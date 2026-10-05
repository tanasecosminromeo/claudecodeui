import { describe, expect, it } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { NormalizedMessage } from '@/shared/types';

describe('notice rows', () => {
  it('shows a live notice as a compact row with its text', () => {
    const converted = normalizedToChatMessages([{
      id: 'notice-1',
      sessionId: 's1',
      timestamp: '2026-10-05T13:00:00.000Z',
      provider: 'claude',
      kind: 'notice',
      content: 'Auto-allowed Bash: git push · sub-agent agent-1',
    } as NormalizedMessage]);

    expect(converted).toHaveLength(1);
    expect(converted[0].content).toBe('Auto-allowed Bash: git push · sub-agent agent-1');
    expect(converted[0].isTaskNotification).toBe(true);
    expect(converted[0].taskNotificationStatus).not.toBe('completed');
  });
});
