import { Stats } from '../App';

interface StatsCardProps {
  stats: Stats;
}

function StatsCard({ stats }: StatsCardProps) {
  return (
    <div className="card">
      <div className="card-title">Statistics</div>
      
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-label">Total Requests</div>
          <div className="stat-value">{stats.totalRequests}</div>
        </div>
        <div className="stat-item">
          <div className="stat-label">Donations</div>
          <div className="stat-value">{stats.donationCount}</div>
        </div>
        <div className="stat-item">
          <div className="stat-label">Total Funded</div>
          <div className="stat-value">${stats.totalDonations.toFixed(2)}</div>
        </div>
        <div className="stat-item">
          <div className="stat-label">Uptime</div>
          <div className="stat-value">{stats.uptime}</div>
        </div>
      </div>
    </div>
  );
}

export default StatsCard;
