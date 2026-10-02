import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';
import { formatElapsed, formatFullTimestamp, lastMessageTime } from '@/modules/chat/utils/lastMessageStamp';

/**
 * When the transcript's last message was sent, both as a full timestamp and as
 * "X ago". The "ago" is measured once, when the last message changes (a new
 * message, a reload, another conversation opened), and then stays put: a
 * counter ticking every second under the reply is a distraction. Inline, so
 * it can sit at the right end of the last message's copy/speak row.
 */
export default function LastMessageStamp({ messages }: { messages: ChatMessage[] }) {
  const time = useMemo(() => lastMessageTime(messages), [messages]);
  if (time === null) return null;
  // Keyed on the time, so a new last message mounts a fresh stamp that
  // measures "now" once.
  return <Stamp key={time} time={time} />;
}

function Stamp({ time }: { time: number }) {
  const { t } = useTranslation('chat');
  const [now] = useState(() => Date.now());
  const timestamp = formatFullTimestamp(new Date(time));
  return (
    <span
      className="whitespace-nowrap text-[11px] italic text-gray-400 dark:text-gray-500"
      data-testid="last-message-stamp"
      title={new Date(time).toString()}
    >
      {t('session.messages.lastMessage', {
        timestamp,
        ago: formatElapsed(now - time),
        defaultValue: 'last message {{timestamp}} · {{ago}} ago',
      })}
    </span>
  );
}
