import { useState, useEffect } from 'react';

interface HeaderProps {
  onBadgeClick: () => void;
  onHistoryClick: () => void;
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

const GITHUB_REPO = 'https://github.com/scrtlabs/self-funding-agent';

function Header({ onBadgeClick, onHistoryClick }: HeaderProps) {
  const [badgeState, setBadgeState] = useState<'success' | 'loading' | 'error'>('loading');
  const [badgeText, setBadgeText] = useState('Verifying...');
  const [version, setVersion] = useState<string>('');
  const [gitTag, setGitTag] = useState<string>('');
  const [gitCommit, setGitCommit] = useState<string>('');

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

    const fetchVersion = async () => {
      try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        if (data.version && data.build) {
          setVersion(`v${data.version}`);
          setGitCommit(data.build);
        }
        if (data.tag) {
          setGitTag(data.tag);
        }
      } catch (err) {
        // Ignore version fetch errors
      }
    };

    checkAttestation();
    fetchVersion();
  }, []);

  const getGitHubUrl = () => {
    if (gitTag) {
      return `${GITHUB_REPO}/releases/tag/${gitTag}`;
    } else if (gitCommit) {
      return `${GITHUB_REPO}/commit/${gitCommit}`;
    }
    return GITHUB_REPO;
  };

  return (
    <div className="header">
      <div className="header-left">
        <button className="history-button" onClick={onHistoryClick} title="View Chat History">
          Chat history powered by Autonomys
          <svg width="22" height="23" viewBox="0 0 139 137" fill="none" xmlns="http://www.w3.org/2000/svg">
            <g clipPath="url(#clip0_62_5)">
              <path d="M87.0098 0L136.38 86.39C138.09 80.35 139 73.97 139 67.38C139 35 116.92 7.78 87.0098 0Z" fill="currentColor"></path>
              <path d="M87.0098 0L136.38 86.39C138.09 80.35 139 73.97 139 67.38C139 35 116.92 7.78 87.0098 0Z" fill="currentColor"></path>
              <path d="M69.5001 137C89.0801 137 106.76 128.88 119.4 115.84H19.6001C32.2301 128.89 49.9201 137 69.5001 137Z" fill="currentColor"></path>
              <path d="M69.5001 137C89.0801 137 106.76 128.88 119.4 115.84H19.6001C32.2301 128.89 49.9201 137 69.5001 137Z" fill="currentColor"></path>
              <path d="M0 67.39C0 73.98 0.92 80.36 2.62 86.4L51.99 0C22.09 7.78 0 35 0 67.39Z" fill="currentColor"></path>
              <path d="M0 67.39C0 73.98 0.92 80.36 2.62 86.4L51.99 0C22.09 7.78 0 35 0 67.39Z" fill="currentColor"></path>
              <path d="M102.53 86.28L69.5 28.48L36.48 86.28H102.53Z" fill="currentColor"></path>
              <path d="M102.53 86.28L69.5 28.48L36.48 86.28H102.53Z" fill="currentColor"></path>
            </g>
            <defs>
              <clipPath id="clip0_62_5">
                <rect width="139" height="137" fill="white"></rect>
              </clipPath>
            </defs>
          </svg>
        </button>
        <div>
          <h1>Funding Agent Dashboard</h1>
          <p>
            Autonomous AI Agent - Community Supported
            {version && (
              <span style={{ opacity: 0.6, fontSize: '0.85em' }}>
                {' • '}
                <a 
                  href={getGitHubUrl()} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  style={{ color: 'inherit', textDecoration: 'none' }}
                  title={`View ${gitTag || gitCommit} on GitHub`}
                >
                  {gitTag || version} ({gitCommit})
                </a>
              </span>
            )}
          </p>
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
