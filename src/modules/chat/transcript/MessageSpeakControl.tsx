import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Volume2, Loader2, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { summarizeVoice } from '@/shared/api';
import { useTts } from '@/modules/chat/hooks/useTts';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';

/** How long the hover menu survives the pointer leaving, so it can reach the menu. */
const HOVER_CLOSE_DELAY_MS = 250;
const POPOVER_WIDTH_PX = 448;

type Summary =
  | { state: 'loading' }
  | { state: 'ready'; text: string; prepared: string }
  | { state: 'error'; error: string };

/** Fixed position for a portaled box next to `anchor`, above it when there is no room below. */
function anchoredStyle(anchor: HTMLElement | null, estimatedHeight: number, width?: number): CSSProperties {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) return { position: 'fixed', zIndex: 1000 };
  const openUp = rect.bottom + estimatedHeight + 8 > window.innerHeight;
  const left = width === undefined
    ? rect.left
    : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  return {
    position: 'fixed',
    left,
    zIndex: 1000,
    ...(width === undefined ? {} : { width: Math.min(width, window.innerWidth - 16) }),
    ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
  };
}

async function fetchSummary(content: string, signal: AbortSignal): Promise<Summary> {
  const response = await summarizeVoice(content, signal);
  const body = await response.json().catch(() => null) as
    | { text?: unknown; prepared?: unknown; error?: unknown }
    | null;
  if (!response.ok || typeof body?.text !== 'string') {
    const error = typeof body?.error === 'string' ? body.error : `Summary failed (${response.status})`;
    return { state: 'error', error };
  }
  return { state: 'ready', text: body.text, prepared: typeof body.prepared === 'string' ? body.prepared : '' };
}

/** Plays one piece of text through the shared player, with the same three states as the main button. */
const SpeakButton = ({ text, label }: { text: string; label: string }) => {
  const { t } = useTranslation('chat');
  const { state, toggle } = useTts(() => text);
  const title = state === 'playing' ? t('voice.stopSpeaking') : state === 'loading' ? t('voice.loading') : label;
  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      aria-label={title}
      className="inline-flex items-center rounded p-1 text-gray-400 transition-colors hover:bg-muted hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
    >
      {state === 'playing' ? (
        <Square className="h-3.5 w-3.5" />
      ) : state === 'loading' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Volume2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
};

// Tap-to-speak button beside the copy control on assistant messages.
// Renders nothing unless the optional voice feature is enabled.
/**
 * Rendered by chat's MessageComponent to read an assistant turn aloud through
 * the shared text-to-speech player. Hovering it offers "Summarised", which
 * shows the summary the speech backend reads long replies as, with its own
 * button to hear just that.
 */
const MessageSpeakControl = ({ content }: { content: string }) => {
  const { t } = useTranslation('chat');
  const available = useVoiceAvailable();
  const { state, toggle, error } = useTts(() => content);
  const [menuOpen, setMenuOpen] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const openMenu = () => {
    cancelClose();
    if (summary) return; // the popover is already showing what the menu offers
    setMenuStyle(anchoredStyle(anchorRef.current, 36));
    setMenuOpen(true);
  };
  const closeMenuSoon = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setMenuOpen(false), HOVER_CLOSE_DELAY_MS);
  };

  const closeSummary = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setSummary(null);
  };

  const showSummary = () => {
    cancelClose();
    setMenuOpen(false);
    setPopoverStyle(anchoredStyle(anchorRef.current, 240, POPOVER_WIDTH_PX));
    setSummary({ state: 'loading' });
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    fetchSummary(content, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSummary(result);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setSummary({ state: 'error', error: reason instanceof Error ? reason.message : 'Summary failed' });
      });
  };

  // Close on a click outside the popover (and outside the speaker itself).
  useEffect(() => {
    if (!summary) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeSummary();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [summary]);

  useEffect(() => () => {
    cancelClose();
    requestRef.current?.abort();
  }, []);

  if (!available) return null;

  const title =
    state === 'playing' ? t('voice.stopSpeaking') : state === 'loading' ? t('voice.loading') : t('voice.speak');

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={openMenu}
      onMouseLeave={closeMenuSoon}
      onFocus={openMenu}
      onBlur={closeMenuSoon}
    >
      {error && (
        <span className="absolute bottom-full left-1/2 z-10 mb-1 max-w-[240px] -translate-x-1/2 whitespace-normal rounded bg-red-600 px-2 py-1 text-center text-xs text-white shadow-lg">
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={toggle}
        title={title}
        aria-label={title}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
      >
        {state === 'playing' ? (
          <Square className="h-3.5 w-3.5" />
        ) : state === 'loading' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Volume2 className="h-3.5 w-3.5" />
        )}
      </button>

      {/* Portaled: the chat message's `contain: paint` box would clip them. */}
      {menuOpen && createPortal(
        <div
          role="menu"
          style={menuStyle}
          onMouseEnter={cancelClose}
          onMouseLeave={closeMenuSoon}
          className="rounded-md border border-border bg-popover py-1 text-xs text-popover-foreground shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={showSummary}
            onFocus={cancelClose}
            onBlur={closeMenuSoon}
            className="block w-full whitespace-nowrap px-3 py-1.5 text-left hover:bg-muted"
          >
            {t('voice.summarised')}
          </button>
        </div>,
        document.body,
      )}

      {summary && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t('voice.summaryTitle')}
          data-testid="speech-summary"
          style={popoverStyle}
          className="rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('voice.summaryTitle')}
            </span>
            {summary.state === 'ready' && summary.prepared !== 'summary' && (
              <span className="text-xs italic text-muted-foreground">{t('voice.summaryNotShortened')}</span>
            )}
            <span className="ml-auto inline-flex items-center gap-1">
              {summary.state === 'ready' && <SpeakButton text={summary.text} label={t('voice.readSummary')} />}
              <button
                type="button"
                onClick={closeSummary}
                title={t('voice.closeSummary')}
                aria-label={t('voice.closeSummary')}
                className="inline-flex items-center rounded p-1 text-gray-400 hover:bg-muted hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
          {summary.state === 'loading' && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('voice.summarising')}
            </div>
          )}
          {summary.state === 'error' && <div className="text-red-600 dark:text-red-400">{summary.error}</div>}
          {summary.state === 'ready' && (
            <div dir="auto" className="max-h-[50vh] overflow-y-auto whitespace-pre-line font-serif leading-relaxed">
              {summary.text}
            </div>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
};

export default MessageSpeakControl;
