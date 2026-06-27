/**
 * Shared voice session summary (by session id).
 *
 * Used by BOTH the local desktop voice agent (VoiceModeService.getSessionSummary)
 * and the mobile voice-tool proxy (mobileVoiceToolHandler), so the iOS agent can
 * summarize ANY session the desktop knows about -- including ones surfaced by the
 * desktop-backed semantic list_sessions that don't exist in the phone's local DB.
 *
 * The canonical transcript lives in ai_transcript_events and is assembled by the
 * renderer; we load it via the existing `ai:loadSession` IPC (the same path the
 * desktop summary already used) for whichever window owns the workspace.
 */

import type { BrowserWindow } from 'electron';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { findWindowByWorkspace } from '../../window/WindowManager';

export interface VoiceSessionSummary {
  success: boolean;
  summary?: string;
  details?: {
    sessionId: string;
    sessionName: string;
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    sessionDurationMinutes: number;
    recentTopics: string[];
  };
  error?: string;
}

/** Build the human-readable summary + details from a loaded session object. */
function buildSummary(sessionId: string, session: any): VoiceSessionSummary {
  // session.messages is TranscriptViewMessage[] from the canonical
  // ai_transcript_events table -- discriminated by `type`, not `role`.
  const messages = (session.messages || []) as Array<any>;
  const userMessages = messages.filter((m) => m.type === 'user_message');
  const assistantMessages = messages.filter((m) => m.type === 'assistant_message');
  const sessionName = session.title || session.name || 'Untitled';

  const createdAt = session.createdAt || Date.now();
  const sessionDurationMinutes = Math.round((Date.now() - createdAt) / 60000);

  const recentTopics = userMessages
    .slice(-5)
    .map((m) => {
      const text = typeof m.text === 'string' ? m.text : '';
      return text.length > 80 ? text.substring(0, 80) + '...' : text;
    })
    .filter((t: string) => t.trim().length > 0);

  const conversationEvents = messages.filter(
    (m) => m.type === 'user_message' || m.type === 'assistant_message',
  );
  const conversationTail = conversationEvents
    .slice(-8)
    .map((m) => {
      const role = m.type === 'user_message' ? 'User' : 'Agent';
      const text = typeof m.text === 'string' ? m.text : '';
      if (!text.trim()) return null;
      const truncated = text.length > 400 ? text.substring(0, 400) + '...' : text;
      return `${role}: ${truncated}`;
    })
    .filter(Boolean) as string[];

  const summaryParts: string[] = [];
  summaryParts.push(
    `Session "${sessionName}" has ${userMessages.length} user messages and ${assistantMessages.length} assistant responses over ${sessionDurationMinutes} minutes.`,
  );
  if (recentTopics.length > 0) {
    summaryParts.push(`Recent topics: ${recentTopics.join('; ')}`);
  } else if (conversationEvents.length === 0) {
    summaryParts.push('No messages yet.');
  }
  if (conversationTail.length > 0) {
    summaryParts.push(`Recent conversation:\n${conversationTail.join('\n')}`);
  }

  return {
    success: true,
    summary: summaryParts.join('\n\n'),
    details: {
      sessionId,
      sessionName,
      messageCount: conversationEvents.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      sessionDurationMinutes,
      recentTopics,
    },
  };
}

/**
 * Summarize a session by id within a workspace, loading its canonical transcript
 * through the renderer that owns the workspace.
 * @param workspacePath The workspace the session belongs to.
 * @param sessionId The session to summarize.
 * @param preferredWindow Optional window to use directly (the active voice window).
 */
export async function getSessionSummaryForVoice(
  workspacePath: string,
  sessionId: string,
  preferredWindow?: BrowserWindow,
): Promise<VoiceSessionSummary> {
  const window = preferredWindow ?? findWindowByWorkspace(workspacePath);
  if (!window || window.isDestroyed()) {
    return { success: false, error: 'The desktop workspace for this session is not open.' };
  }

  const loadSession = async (id: string): Promise<any> =>
    window.webContents.executeJavaScript(`
      window.electronAPI.invoke('ai:loadSession', ${JSON.stringify(id)}, ${JSON.stringify(workspacePath)}, false)
    `);

  try {
    let resolvedId = sessionId;
    let session = await loadSession(sessionId);

    // The voice model sometimes hands us a session TITLE instead of its id (it
    // surfaces both via list_sessions and occasionally passes the wrong field).
    // Fall back to resolving the value as a title before giving up.
    if (!session) {
      const resolved = await resolveSessionIdFromTitle(workspacePath, sessionId);
      if (resolved && resolved !== sessionId) {
        resolvedId = resolved;
        session = await loadSession(resolved);
      }
    }

    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    return buildSummary(resolvedId, session);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve a session id from a value that may actually be a session title.
 * Returns the id of the best title match (exact, case-insensitive), or
 * undefined when nothing matches.
 */
async function resolveSessionIdFromTitle(
  workspacePath: string,
  value: string,
): Promise<string | undefined> {
  const needle = value.trim().toLowerCase();
  if (!needle) return undefined;
  try {
    const all = await AISessionsRepository.list(workspacePath);
    const exact = all.find((s) => (s.title || '').trim().toLowerCase() === needle);
    if (exact) return exact.id;
  } catch {
    // Best-effort fallback only.
  }
  return undefined;
}
