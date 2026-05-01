import { useState, useEffect } from 'react';

interface HeaderProps {
  onBadgeClick: () => void;
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

const GITHUB_REPO = 'https://github.com/scrtlabs/self-funding-agent';

function Header({ onBadgeClick }: HeaderProps) {
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
