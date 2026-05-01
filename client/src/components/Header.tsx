import { useState, useEffect } from 'react';

interface HeaderProps {
  onBadgeClick: () => void;
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

function Header({ onBadgeClick }: HeaderProps) {
  const [badgeState, setBadgeState] = useState<'success' | 'loading' | 'error'>('loading');
  const [badgeText, setBadgeText] = useState('Verifying...');

  useEffect(() => {
    const checkAttestation = async () => {
      setBadgeState('loading');
      setBadgeText('Verifying...');
      
      try {
        const res = await fetch(`${API_BASE}/api/attestation`);
        const data = await res.json();
        
        if (data.valid) {
          setBadgeState('success');
          setBadgeText('Verified Confidential');
        } else {
          setBadgeState('error');
          setBadgeText('Verification Failed');
        }
      } catch (err) {
        setBadgeState('error');
        setBadgeText('Verification Failed');
      }
    };

    checkAttestation();
  }, []);

  return (
    <div className="header">
      <div className="header-left">
        <div>
          <h1>Funding Agent Dashboard</h1>
          <p>Autonomous AI Agent - Community Supported</p>
        </div>
      </div>
      <div className={`tee-badge ${badgeState}`} onClick={onBadgeClick}>
        <span className="dot"></span>
        <span className="tee-text">{badgeText}</span>
      </div>
    </div>
  );
}

export default Header;
