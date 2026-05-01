import { useState, useEffect } from 'react'
import Header from './components/Header'
import BalanceHero from './components/BalanceHero'
import ChatCard from './components/ChatCard'
import SecretAiChat from './components/SecretAiChat'
import StatsCard from './components/StatsCard'
import AttestationPanel from './components/AttestationPanel'
import Toast from './components/Toast'
import './App.css'

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

export interface Stats {
  totalRequests: number;
  donationCount: number;
  totalDonations: number;
  uptime: string;
  vmBalance: number;
  currentBalance: number;
  threshold: number;
}

function App() {
  const [walletAddress, setWalletAddress] = useState<string>('Loading...');
  const [stats, setStats] = useState<Stats>({
    totalRequests: 0,
    donationCount: 0,
    totalDonations: 0,
    uptime: '0m',
    vmBalance: 0,
    currentBalance: 0,
    threshold: 0.5,
  });
  const [isConnected, setIsConnected] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);

  const showToastMessage = (message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 3000);
  };

  const checkHealth = async () => {
    try {
      const response = await fetch(`${API_BASE}/health`);
      const data = await response.json();
      setIsConnected(true);
      setWalletAddress(data.wallet);
    } catch (error) {
      setIsConnected(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/stats`);
      const data = await response.json();
      setStats({
        totalRequests: data.stats.totalRequests,
        donationCount: data.stats.donationCount,
        totalDonations: data.stats.totalDonations,
        uptime: data.stats.uptime,
        vmBalance: data.stats.vmBalance || 0,
        currentBalance: data.stats.currentBalance || 0,
        threshold: data.stats.threshold || 0.5,
      });
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  useEffect(() => {
    checkHealth();
    loadStats();

    const statsInterval = setInterval(loadStats, 10000);
    const healthInterval = setInterval(checkHealth, 5000);

    return () => {
      clearInterval(statsInterval);
      clearInterval(healthInterval);
    };
  }, []);

  return (
    <>
      <div className="container">
        <Header 
          onBadgeClick={() => setPanelOpen(!panelOpen)}
        />
        
        <BalanceHero
          walletBalance={stats.currentBalance}
          vmBalance={stats.vmBalance}
          walletAddress={walletAddress}
          threshold={stats.threshold}
          onCopyWallet={() => {
            navigator.clipboard.writeText(walletAddress);
            showToastMessage('Wallet address copied to clipboard!');
          }}
        />

        <div className="grid">
          <ChatCard 
            isConnected={isConnected}
            onStatsUpdate={loadStats}
            showToast={showToastMessage}
          />
          <StatsCard stats={stats} />
        </div>

        <div className="grid" style={{ marginTop: '20px' }}>
          <SecretAiChat isConnected={isConnected} />
        </div>
      </div>

      <Toast message={toastMessage} show={showToast} />
      <AttestationPanel 
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
      />
    </>
  )
}

export default App
