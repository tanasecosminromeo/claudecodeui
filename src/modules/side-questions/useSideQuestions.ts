import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { Project, SideQuestionCommandData, SideQuestionEntry } from '@/shared/types';
import {
  setSideQuestionList,
  upsertSideQuestionEntry,
  useSideQuestionEntries,
  useSideQuestionTranscriptPath,
  useSideQuestionsPanelOpen,
} from '@/modules/side-questions/sideQuestionsStore';

type SideQuestionListResponse = {
  entries: SideQuestionEntry[];
  transcriptPath: string | null;
};

/**
 * The side questions of one session: loads them on mount, on a session change,
 * when the panel opens and when the socket reconnects (a tab that slept may
 * have missed updates), applies `side_question_updated` frames, and asks new
 * ones through the same `/btw` command the composer uses.
 */
export function useSideQuestions(sessionId: string | null, project: Project | null) {
  const { t } = useTranslation('chat');
  const { subscribe, connectionStatus } = useWebSocket();
  const isOpen = useSideQuestionsPanelOpen();
  const entries = useSideQuestionEntries(sessionId);
  const transcriptPath = useSideQuestionTranscriptPath(sessionId);
  // Why the last question was not asked, or a request that failed; cleared on the next ask.
  const [notice, setNotice] = useState<string | null>(null);

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const loadList = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    try {
      const response = await api.commands.sideQuestions(sessionId);
      if (!response.ok) {
        throw new Error(`Failed to load side questions (${response.status})`);
      }
      const body = (await response.json()) as SideQuestionListResponse;
      // A slow response for a session the user has left must not overwrite the current one.
      if (sessionIdRef.current !== sessionId) {
        return;
      }
      setSideQuestionList(sessionId, body.entries, body.transcriptPath ?? null);
    } catch (error) {
      console.error('Error loading side questions:', error);
    }
  }, [sessionId]);

  // Runs on mount, on a session change and on open. The list also feeds the
  // title's count while the panel is closed, so it is not gated on `isOpen`.
  useEffect(() => {
    void loadList();
  }, [loadList, isOpen]);

  const previousStatusRef = useRef(connectionStatus);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = connectionStatus;
    if (connectionStatus === 'connected' && previousStatus !== 'connected') {
      void loadList();
    }
  }, [connectionStatus, loadList]);

  useEffect(() => subscribe((event) => {
    if (event.kind !== 'side_question_updated') {
      return;
    }
    const entry = event.entry as SideQuestionEntry | undefined;
    if (entry && typeof entry.sessionId === 'string') {
      upsertSideQuestionEntry(entry);
    }
  }), [subscribe]);

  const ask = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text || !sessionId || !project) {
      return;
    }
    setNotice(null);
    try {
      const response = await api.commands.execute({
        commandName: '/btw',
        args: [text],
        context: {
          projectPath: project.fullPath || project.path,
          projectId: project.projectId,
          sessionId,
          provider: 'claude',
          model: null,
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to ask (${response.status})`);
      }
      const result = (await response.json()) as { data?: SideQuestionCommandData };
      const data = result.data ?? {};
      if (data.entry) {
        upsertSideQuestionEntry(data.entry);
        return;
      }
      setNotice(data.status ? t(`misc.sideQuestion.${data.status}`) : data.message ?? null);
    } catch (error) {
      console.error('Error asking a side question:', error);
      setNotice(t('misc.sideQuestion.failed'));
    }
  }, [project, sessionId, t]);

  const retry = useCallback((entry: SideQuestionEntry) => ask(entry.question), [ask]);

  return {
    entries,
    transcriptPath,
    notice,
    canAsk: Boolean(sessionId && project),
    ask,
    retry,
  };
}
