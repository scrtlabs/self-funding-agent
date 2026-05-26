import { useEffect, useState } from 'react';

interface UsageEntry {
  id: string;
  createdAt: string;
  description?: string | null;
  amount?: number | null;
  model?: string | null;
  vmDevTokenHint?: string | null;
}

interface UsageDayGroup {
  date: string;
  totalAmount: number;
  usages: UsageEntry[];
}

interface UsageHistoryResponse {
  dayGroups: UsageDayGroup[];
  totalDays: number;
  totalPages: number;
  currentPage: number;
}

interface UsageHistoryCardProps {
  apiBase: string;
}

export default function UsageHistoryCard({ apiBase }: UsageHistoryCardProps) {
  const [usageHistory, setUsageHistory] = useState<UsageHistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 5;

  const loadUsageHistory = async (page: number) => {
    try {
      setIsLoading(true);
      setErrorMessage(null);
      const response = await fetch(`${apiBase}/api/agent/usage-history?page=${page}&pageSize=${pageSize}&service=ALL`);
      if (!response.ok) {
        throw new Error(`Usage history request failed (${response.status})`);
      }
      const data = await response.json() as UsageHistoryResponse;
      setUsageHistory(data);
      setCurrentPage(page);
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to load usage history.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsageHistory(1);
  }, []);

  return (
    <div className="card usage-card">
      <div className="card-title">
        Agent Usage History
      </div>

      <p className="usage-card-subtitle">
        SecretAI usage charges from the devportal.
      </p>

      <div className="usage-card-actions">
        <button onClick={() => loadUsageHistory(currentPage)} disabled={isLoading}>
          {isLoading ? 'Refreshing...' : 'Refresh Usage'}
        </button>
      </div>

      {errorMessage ? (
        <div className="error-message">{errorMessage}</div>
      ) : null}

      {isLoading && !usageHistory ? (
        <div className="loading">Loading usage history...</div>
      ) : null}

      {usageHistory && usageHistory.dayGroups.length === 0 ? (
        <div className="loading-message" style={{ textAlign: 'center', color: 'white' }}>No usage entries yet.</div>
      ) : null}

      {usageHistory?.dayGroups?.map((group) => (
        <div key={group.date} className="usage-day">
          <div className="usage-day-header">
            <span>{group.date}</span>
            <span>${group.totalAmount < 0.01 && group.totalAmount > 0 ? group.totalAmount.toFixed(6) : group.totalAmount.toFixed(2)}</span>
          </div>
          <div className="usage-entries">
            {group.usages.map((usage) => (
              <div key={usage.id} className="usage-entry">
                <div className="usage-entry-main">
                  <span>{usage.description || 'AI usage charge'}</span>
                  <span className="usage-entry-amount">
                    ${(() => {
                      const amt = Math.abs(Number(usage.amount || 0));
                      return amt < 0.01 && amt > 0 ? amt.toFixed(6) : amt.toFixed(2);
                    })()}
                  </span>
                </div>
                <div className="usage-entry-meta">
                  {usage.model ? <span>Model: {usage.model}</span> : null}
                  {usage.vmDevTokenHint ? <span>VM: {usage.vmDevTokenHint}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {usageHistory && usageHistory.totalPages > 1 && (
        <div className="pagination">
          <button
            disabled={currentPage <= 1}
            onClick={() => loadUsageHistory(currentPage - 1)}
          >
            Previous
          </button>
          <span>Page {currentPage} of {usageHistory.totalPages}</span>
          <button
            disabled={currentPage >= usageHistory.totalPages}
            onClick={() => loadUsageHistory(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
