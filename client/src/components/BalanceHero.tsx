interface BalanceHeroProps {
  walletBalance: number;
  vmBalance: number;
  walletAddress: string;
  threshold: number;
  onCopyWallet: () => void;
}

function BalanceHero({ walletBalance, vmBalance, walletAddress, threshold, onCopyWallet }: BalanceHeroProps) {
  return (
    <div className="balance-hero">
      <div className="balance-grid">
        <div className="balance-section">
          <div className="balance-label">Agent Wallet Balance</div>
          <div className="balance-amount">${walletBalance.toFixed(2)}</div>
          <div className="balance-subtext">On-chain wallet funds</div>
          
          <div className="wallet-info">
            <div className="wallet-label">SUPPORT WALLET</div>
            <div className="wallet-address-container">
              <div className="wallet-address" onClick={onCopyWallet}>
                {walletAddress}
              </div>
              <span className="copy-btn" onClick={onCopyWallet}>Copy</span>
            </div>
          </div>
        </div>
        
        <div className="balance-section bordered">
          <div className="balance-label">Agent VM Balance</div>
          <div className="balance-amount">${vmBalance.toFixed(2)}</div>
          <div className="balance-subtext">Available compute credits</div>
          
          <div className="wallet-info">
            <div className="wallet-label">AUTO TOP-UP RULES</div>
            <div className="auto-topup-info">
              <div><strong>Threshold:</strong> ${threshold.toFixed(2)}</div>
              <div><strong>Top-up Amount:</strong> Full wallet balance</div>
              <div><strong>Check Interval:</strong> 60s</div>
              <div>
                When VM balance drops below threshold, agent automatically transfers entire wallet balance to VM.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BalanceHero;
