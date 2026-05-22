import { useState, useEffect } from 'react';

interface ChatHistoryRecord {
  requestId: string;
  endpoint: string;
  timestamp: string;
  request: unknown;
  response?: unknown;
  error?: { message: string };
  metadata?: Record<string, unknown>;
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

interface ChatHistoryPageProps {
  onBack: () => void;
}

function ChatHistoryPage({ onBack }: ChatHistoryPageProps) {
  const [records, setRecords] = useState<ChatHistoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<ChatHistoryRecord | null>(null);
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
    } catch (err) {
      setError('Failed to load chat history');
    } finally {
      setLoading(false);
    }
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
      const msgs = (record.request as { messages?: Array<{ content: string }> })?.messages || [];
      const lastUser = [...msgs].reverse().find(m => m.content);
      return lastUser?.content?.slice(0, 100) || 'Chat';
    }
    return record.endpoint;
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
        <span className="total-count">{total} total chats</span>
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">Loading...</div>
      ) : (
        <>
          <div className="history-list">
            {records.map((record) => (
              <div
                key={record.requestId}
                className="history-item"
                onClick={() => setSelectedRecord(record)}
              >
                <div className="history-item-header">
                  <span className="endpoint">{record.endpoint}</span>
                  <span className="timestamp">{formatDate(record.timestamp)}</span>
                </div>
                <div className="history-preview">{getPreview(record)}</div>
                {record.metadata?.ip && (
                  <div className="history-meta">IP: {String(record.metadata.ip).slice(0, 20)}...</div>
                )}
              </div>
            ))}
          </div>

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

      {selectedRecord && (
        <div className="modal-overlay" onClick={() => setSelectedRecord(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Chat Details</h3>
              <button className="close-button" onClick={() => setSelectedRecord(null)}>×</button>
            </div>
            <div className="modal-body">
              <p><strong>Request ID:</strong> {selectedRecord.requestId}</p>
              <p><strong>Endpoint:</strong> {selectedRecord.endpoint}</p>
              <p><strong>Timestamp:</strong> {formatDate(selectedRecord.timestamp)}</p>
              <details>
                <summary>Request</summary>
                <pre>{JSON.stringify(selectedRecord.request, null, 2)}</pre>
              </details>
              <details>
                <summary>Response</summary>
                <pre>{JSON.stringify(selectedRecord.response, null, 2)}</pre>
              </details>
              {selectedRecord.error && (
                <details>
                  <summary>Error</summary>
                  <pre>{JSON.stringify(selectedRecord.error, null, 2)}</pre>
                </details>
              )}
              {selectedRecord.metadata && (
                <details>
                  <summary>Metadata</summary>
                  <pre>{JSON.stringify(selectedRecord.metadata, null, 2)}</pre>
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatHistoryPage;