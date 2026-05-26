import { useState, useEffect } from 'react';
import { API_BASE } from '../config/api';
import { extractChatContent, extractThinkingContent } from '../utils/chatResponse';

interface ChatHistoryRecord {
  requestId: string;
  endpoint: string;
  timestamp: string;
  request: unknown;
  response?: unknown;
  error?: { message: string };
  metadata?: Record<string, unknown>;
  sessionId?: string;
  messageIndex?: number;
  cid?: string;
}

interface ChatSession {
  sessionId: string;
  messages: ChatHistoryRecord[];
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
}

interface ChatHistoryPageProps {
  onBack: () => void;
}

function ChatHistoryPage({ onBack }: ChatHistoryPageProps) {
  const [records, setRecords] = useState<ChatHistoryRecord[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(null);
  const [viewMode, setViewMode] = useState<'sessions' | 'messages'>('sessions');
  const [loadingMessages, setLoadingMessages] = useState(false);
  const limit = 20;

  const fetchHistory = async (newOffset: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `${API_BASE}/api/chat-history?limit=${limit}&offset=${newOffset}`
      );
      const data = await res.json();
      setRecords(data.records);
      setTotal(data.total);
      setOffset(newOffset);
      
      // Group records by session
      groupRecordsBySessions(data.records);
    } catch (err) {
      setError('Failed to load chat history');
    } finally {
      setLoading(false);
    }
  };

  const fetchMessageContent = async (cid: string): Promise<any> => {
    try {
      const res = await fetch(`${API_BASE}/api/chat-history/${cid}`);
      if (!res.ok) {
        throw new Error('Failed to fetch message content');
      }
      return await res.json();
    } catch (err) {
      console.error('Error fetching message content:', err);
      return null;
    }
  };

  const loadSessionMessages = async (session: ChatSession) => {
    setLoadingMessages(true);
    
    // Fetch full content for each message in the session
    const messagesWithContent = await Promise.all(
      session.messages.map(async (record) => {
        if (!record.cid) return record;
        
        const content = await fetchMessageContent(record.cid);
        if (!content) return record;
        
        // Merge the downloaded content with the record
        return {
          ...record,
          request: {
            model: content.model,
            messages: content.messages,
          },
          response: content.response,
          error: content.error,
        };
      })
    );
    
    setSelectedSession({
      ...session,
      messages: messagesWithContent,
    });
    
    setLoadingMessages(false);
  };

  const groupRecordsBySessions = (records: ChatHistoryRecord[]) => {
    const sessionMap = new Map<string, ChatHistoryRecord[]>();
    
    records.forEach(record => {
      const sessionId = record.sessionId || record.metadata?.sessionId as string || 'no-session';
      
      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, []);
      }
      sessionMap.get(sessionId)!.push(record);
    });
    
    const groupedSessions: ChatSession[] = [];
    
    sessionMap.forEach((messages, sessionId) => {
      messages.sort((a, b) => {
        const indexA = a.messageIndex ?? 0;
        const indexB = b.messageIndex ?? 0;
        return indexA - indexB;
      });
      
      const timestamps = messages.map(m => new Date(m.timestamp).getTime());
      
      groupedSessions.push({
        sessionId,
        messages,
        firstTimestamp: new Date(Math.min(...timestamps)).toISOString(),
        lastTimestamp: new Date(Math.max(...timestamps)).toISOString(),
        messageCount: messages.length,
      });
    });
    
    // Sort sessions by last timestamp (most recent first)
    groupedSessions.sort((a, b) => 
      new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()
    );
    
    setSessions(groupedSessions);
  };

  useEffect(() => {
    fetchHistory(0);
  }, []);

  const formatDate = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const getPreview = (record: ChatHistoryRecord) => {
    if (record.endpoint === '/api/chat') {
      const msg = (record.request as { message?: string })?.message || '';
      return msg.slice(0, 100) + (msg.length > 100 ? '...' : '');
    }
    if (record.endpoint === '/api/secretai/chat') {
      const msgs = (record.request as { messages?: Array<{ content: string; role: string }> })?.messages || [];
      const lastUser = [...msgs].reverse().find(m => m.role === 'user');
      return lastUser?.content?.slice(0, 100) || 'Chat';
    }
    return record.endpoint;
  };

  const getSessionPreview = (session: ChatSession) => {
    if (session.messages.length === 0) return 'Empty session';
    
    const firstMessage = session.messages[0];
    return getPreview(firstMessage);
  };

  const buildAutonomysUrl = (record: ChatHistoryRecord) => {
    // Use CID if available
    if (record.cid) {
      return `https://explorer.ai3.storage/mainnet/drive/metadata/${record.cid}`;
    }
    
    return null;
  };

  const extractMessageContent = (record: ChatHistoryRecord) => {
    const request = record.request as any;
    const response = record.response as any;
    
    // Extract user message
    let userMessage = '';
    if (request?.messages && Array.isArray(request.messages)) {
      const lastUserMsg = [...request.messages].reverse().find((m: any) => m.role === 'user');
      userMessage = lastUserMsg?.content || '';
    }
    
    // Extract assistant response using shared utility
    let assistantMessage = '';
    let thinking = '';
    
    if (response?.content) {
      // Lightweight payload format (v2.0)
      assistantMessage = response.content;
      thinking = response.thinking || '';
    } else {
      // Use shared utility for other formats
      assistantMessage = extractChatContent(response);
      thinking = extractThinkingContent(response);
    }
    
    return { userMessage, assistantMessage, thinking };
  };

  const hasNext = offset + limit < total;
  const hasPrev = offset > 0;

  return (
    <div className="history-page">
      <div className="history-header">
        <button className="back-button" onClick={onBack}>
          ← Back
        </button>
        <h2>Chat History</h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span className="total-count">
            {viewMode === 'sessions' ? `${sessions.length} total chats` : `${total} total messages`}
          </span>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">Loading...</div>
      ) : (
        <>
          {viewMode === 'sessions' ? (
            <div className="history-list">
              {sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="history-item"
                  onClick={() => loadSessionMessages(session)}
                >
                  <div className="history-item-header">
                    <span className="endpoint">Session: 662de4...1d54c0</span>
                    <span className="timestamp">{formatDate(session.lastTimestamp)}</span>
                  </div>
                  <div className="history-preview">{getSessionPreview(session)}</div>
                  <div className="history-meta">{session.messageCount} messages</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="history-list">
              {records.map((record) => (
                <div
                  key={record.requestId}
                  className="history-item"
                  onClick={() => loadSessionMessages({
                    sessionId: record.sessionId || 'single',
                    messages: [record],
                    firstTimestamp: record.timestamp,
                    lastTimestamp: record.timestamp,
                    messageCount: 1,
                  })}
                >
                  <div className="history-item-header">
                    <span className="endpoint">{record.endpoint}</span>
                    <span className="timestamp">{formatDate(record.timestamp)}</span>
                  </div>
                  <div className="history-preview">{getPreview(record)}</div>
                  {record.sessionId && (
                    <div className="history-meta">
                      Session: 662de4...1d54c0 | Msg #{record.messageIndex}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="pagination">
            <button
              disabled={!hasPrev}
              onClick={() => fetchHistory(offset - limit)}
            >
              Previous
            </button>
            <span>{offset + 1}-{Math.min(offset + limit, total)} of {total}</span>
            <button
              disabled={!hasNext}
              onClick={() => fetchHistory(offset + limit)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {selectedSession && (
        <div className="modal-overlay" onClick={() => setSelectedSession(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Chat Session</h3>
              <button className="close-button" onClick={() => setSelectedSession(null)}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ marginBottom: '20px', paddingBottom: '15px', borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
                <p><strong>Session ID:</strong> 662de4...1d54c0</p>
                <p><strong>Messages:</strong> {selectedSession.messageCount}</p>
                <p><strong>Started:</strong> {formatDate(selectedSession.firstTimestamp)}</p>
                <p><strong>Last Activity:</strong> {formatDate(selectedSession.lastTimestamp)}</p>
              </div>
              
              {loadingMessages ? (
                <div className="loading">Loading messages from Autonomys...</div>
              ) : (
                <div className="chat-container" style={{ height: '500px', marginBottom: '0' }}>
                  {selectedSession.messages.map((record, idx) => {
                    const { userMessage, assistantMessage, thinking } = extractMessageContent(record);
                    const autonomysUrl = buildAutonomysUrl(record);
                    
                    return (
                      <div key={record.requestId}>
                        {/* Message metadata */}
                        <div style={{ 
                          fontSize: '11px', 
                          color: 'rgba(255, 255, 255, 0.5)', 
                          marginBottom: '8px',
                          textAlign: 'center'
                        }}>
                          <span>Message #{record.messageIndex ?? idx + 1}</span>
                          <span style={{ margin: '0 8px' }}>•</span>
                          <span>{formatDate(record.timestamp)}</span>
                          {autonomysUrl && (
                            <>
                              <span style={{ margin: '0 8px' }}>•</span>
                              <a 
                                href={autonomysUrl} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                style={{ color: '#a5b4fc', textDecoration: 'none' }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                View on Autonomys
                              </a>
                            </>
                          )}
                        </div>
                        
                        {/* User message */}
                        {userMessage && (
                          <div className="message user">
                            <div className="message-content">
                              {userMessage}
                            </div>
                          </div>
                        )}
                        
                        {/* Assistant message */}
                        {assistantMessage && (
                          <div className="message assistant">
                            <div className="message-header">Funding Agent</div>
                            <div className="message-content">
                              {assistantMessage}
                            </div>
                            {thinking && (
                              <div className="message-thinking">
                                <div className="thinking-label">Thinking:</div>
                                <div className="thinking-content">{thinking}</div>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Error display */}
                        {record.error && (
                          <div className="error-message" style={{ marginTop: '8px', marginBottom: '16px' }}>
                            <strong>Error:</strong> {record.error.message}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatHistoryPage;