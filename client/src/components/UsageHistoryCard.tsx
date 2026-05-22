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

  const loadUsageHistory = async () => {
    try {
      setIsLoading(true);
      setErrorMessage(null);
      const response = await fetch(`${apiBase}/api/agent/usage-history?page=1&pageSize=5&service=ALL`);
      if (!response.ok) {
        throw new Error(`Usage history request failed (${response.status})`);
      }
      const data = await response.json() as UsageHistoryResponse;
      setUsageHistory(data);
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to load usage history.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsageHistory();
  }, []);

  return (
    <div className="card usage-card">
      <div className="card-title">
        Agent Usage History
      </div>

      <p className="usage-card-subtitle">
        Last 5 days of SecretAI usage charges from the devportal.
      </p>

      <div className="usage-card-actions">
        <button onClick={loadUsageHistory} disabled={isLoading}>
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
        <div className="loading-message">No usage entries yet.</div>
      ) : null}

      {usageHistory?.dayGroups?.map((group) => (
        <div key={group.date} className="usage-day">
          <div className="usage-day-header">
            <span>{group.date}</span>
            <span>${group.totalAmount.toFixed(4)}</span>
          </div>
          <div className="usage-entries">
            {group.usages.map((usage) => (
              <div key={usage.id} className="usage-entry">
                <div className="usage-entry-main">
                  <span>{usage.description || 'AI usage charge'}</span>
                  <span className="usage-entry-amount">
                    ${Math.abs(Number(usage.amount || 0)).toFixed(4)}
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
    </div>
  );
}
