import { useState, useEffect } from 'react';

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
}

interface ChatSession {
  sessionId: string;
  messages: ChatHistoryRecord[];
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

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
    if (!record.sessionId || record.messageIndex === undefined) return null;
    
    const eventDate = new Date(record.timestamp);
    const year = String(eventDate.getUTCFullYear());
    const month = String(eventDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(eventDate.getUTCDate()).padStart(2, '0');
    const messageIndex = String(record.messageIndex).padStart(4, '0');
    const safeSessionId = record.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeSessionId}-${messageIndex}-${eventDate.getTime()}.json`;
    const keyPrefix = 'chat-history';
    
    // Build the full path
    const fullPath = `${keyPrefix}/${year}/${month}/${day}/${fileName}`;
    
    // Autonomys Auto Drive URL format (this may need adjustment based on actual URL structure)
    return `https://auto-drive.autonomys.xyz/file/${fullPath}`;
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
    
    // Extract assistant response
    let assistantMessage = '';
    let thinking = '';
    
    if (response?.message?.content) {
      assistantMessage = response.message.content;
      thinking = response.message.thinking || '';
    } else if (response?.response) {
      assistantMessage = response.response;
    } else if (response?.choices?.[0]?.message?.content) {
      assistantMessage = response.choices[0].message.content;
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
          <button 
            onClick={() => setViewMode('sessions')}
            className={viewMode === 'sessions' ? 'active' : ''}
          >
            By Sessions
          </button>
          <button 
            onClick={() => setViewMode('messages')}
            className={viewMode === 'messages' ? 'active' : ''}
          >
            All Messages
          </button>
          <span className="total-count">{total} total</span>
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
                  onClick={() => setSelectedSession(session)}
                >
                  <div className="history-item-header">
                    <span className="endpoint">Session: {session.sessionId.slice(0, 12)}...</span>
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
                  onClick={() => setSelectedSession({
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
                      Session: {record.sessionId.slice(0, 8)}... | Msg #{record.messageIndex}
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
              <div style={{ marginBottom: '20px', paddingBottom: '15px', borderBottom: '1px solid #444' }}>
                <p><strong>Session ID:</strong> {selectedSession.sessionId}</p>
                <p><strong>Messages:</strong> {selectedSession.messageCount}</p>
                <p><strong>Started:</strong> {formatDate(selectedSession.firstTimestamp)}</p>
                <p><strong>Last Activity:</strong> {formatDate(selectedSession.lastTimestamp)}</p>
              </div>
              
              <div className="chat-container" style={{ maxHeight: '500px', overflowY: 'auto' }}>
                {selectedSession.messages.map((record, idx) => {
                  const { userMessage, assistantMessage, thinking } = extractMessageContent(record);
                  const autonomysUrl = buildAutonomysUrl(record);
                  
                  return (
                    <div key={record.requestId} style={{ marginBottom: '30px' }}>
                      {/* Message metadata */}
                      <div style={{ fontSize: '0.85em', color: '#888', marginBottom: '10px' }}>
                        <span>Message #{record.messageIndex ?? idx + 1}</span>
                        <span style={{ margin: '0 10px' }}>•</span>
                        <span>{formatDate(record.timestamp)}</span>
                        {autonomysUrl && (
                          <>
                            <span style={{ margin: '0 10px' }}>•</span>
                            <a 
                              href={autonomysUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              style={{ color: '#4a9eff', textDecoration: 'none' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              View on Autonomys
                            </a>
                          </>
                        )}
                      </div>
                      
                      {/* User message */}
                      {userMessage && (
                        <div className="message user" style={{ 
                          marginBottom: '10px',
                          padding: '12px 16px',
                          backgroundColor: '#2a2a2a',
                          borderRadius: '8px',
                          marginLeft: '20%',
                        }}>
                          <div style={{ fontSize: '0.9em', color: '#aaa', marginBottom: '5px' }}>You</div>
                          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{userMessage}</div>
                        </div>
                      )}
                      
                      {/* Assistant message */}
                      {assistantMessage && (
                        <div className="message assistant" style={{ 
                          padding: '12px 16px',
                          backgroundColor: '#1a3a1a',
                          borderRadius: '8px',
                          marginRight: '20%',
                        }}>
                          <div style={{ fontSize: '0.9em', color: '#aaa', marginBottom: '5px' }}>Assistant</div>
                          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{assistantMessage}</div>
                          {thinking && (
                            <details style={{ marginTop: '10px', fontSize: '0.9em', color: '#999' }}>
                              <summary style={{ cursor: 'pointer' }}>Thinking process</summary>
                              <div style={{ marginTop: '5px', padding: '8px', backgroundColor: '#0a0a0a', borderRadius: '4px' }}>
                                {thinking}
                              </div>
                            </details>
                          )}
                        </div>
                      )}
                      
                      {/* Error display */}
                      {record.error && (
                        <div style={{ 
                          marginTop: '10px',
                          padding: '12px 16px',
                          backgroundColor: '#3a1a1a',
                          borderRadius: '8px',
                          color: '#ff6b6b'
                        }}>
                          <strong>Error:</strong> {record.error.message}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatHistoryPage;