import { useState, useEffect } from 'react';
import './AttestationPanel.css';

interface AttestationPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface AttestationData {
  valid: boolean;
  attestHost?: string;
  error?: string;
  checks?: {
    cpu: {
      passed: boolean | null;
      platform: string;
      product: string | null;
      measurement: string | null;
    };
    workload: {
      passed: boolean | null;
      status: string | null;
      templateName: string | null;
    };
    tlsBinding: {
      passed: boolean | null;
      fingerprint: string | null;
    };
    gpu: {
      passed: boolean | null;
      cpuBound: boolean | null;
      model: string | null;
      secureBoot: boolean | null;
    };
    proofOfCloud: {
      passed: boolean | null;
    };
  };
  links?: {
    cpuQuote: string;
    dockerCompose: string;
    gpuAttestation: string;
  };
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

function AttestationPanel({ isOpen, onClose }: AttestationPanelProps) {
  const [attestationData, setAttestationData] = useState<AttestationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const runAttestation = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/attestation`);
      const data = await res.json();
      setAttestationData(data);
    } catch (err: any) {
      setAttestationData({ valid: false, error: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && !attestationData) {
      runAttestation();
    }
  }, [isOpen]);

  const toggleItem = (id: string) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedItems(newExpanded);
  };

  const renderAttestItem = (
    id: string,
    title: string,
    description: string,
    passed: boolean | null,
    details: Array<{ label: string; value: string | null }>,
    link?: { url: string; text: string }
  ) => {
    const stateClass = passed === true ? 'pass' : passed === false ? 'fail' : 'na';
    const icon = passed === true ? '✓' : passed === false ? '✗' : '—';
    const isExpanded = expandedItems.has(id);

    return (
      <div key={id} className={`attest-item ${isExpanded ? 'expanded' : ''}`}>
        <div className="attest-header" onClick={() => toggleItem(id)}>
          <div className={`attest-icon ${stateClass}`}>{icon}</div>
          <div className="attest-title">{title}</div>
          <span className="attest-chevron">▶</span>
        </div>
        <div className="attest-body">
          <p>{description}</p>
          {details.filter(d => d.value != null).map((d, i) => (
            <div key={i} className="attest-detail">
              <span className="label">{d.label}</span>
              <span className="value">{d.value}</span>
            </div>
          ))}
          {link && (
            <div style={{ marginTop: '12px' }}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                ↗ {link.text}
              </a>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`side-panel ${isOpen ? 'open' : ''}`}>
      <div className="side-panel-inner">
        <div className="panel-header">
          <div className="panel-header-top">
            <h2>Verification Center</h2>
            <button className="panel-close-btn" onClick={onClose}>×</button>
          </div>
          <div className="panel-server">
            {loading ? 'Checking attestation...' : attestationData?.attestHost ? `Attestation Host: ${attestationData.attestHost}` : 'Waiting...'}
          </div>
        </div>

        <div className={`status-banner ${loading ? 'loading' : attestationData?.valid ? 'success' : 'failure'}`}>
          {loading ? 'Verifying...' : attestationData?.valid ? '✓ All checks passed' : attestationData?.error ? `✗ ${attestationData.error}` : '✗ Some checks failed'}
        </div>

        <button className="verify-btn" onClick={runAttestation} disabled={loading}>
          ↻ Verify Again
        </button>

        <div className="attestation-list">
          {attestationData?.checks && (
            <>
              {renderAttestItem(
                'cpu',
                `Genuine ${attestationData.checks.cpu.platform || 'TEE'} Machine`,
                attestationData.checks.cpu.passed
                  ? "This server runs inside a genuine trusted execution environment. The CPU attestation quote has been cryptographically verified against the hardware vendor's root of trust."
                  : 'CPU attestation could not be verified. The hardware may not be running inside a genuine trusted execution environment.',
                attestationData.checks.cpu.passed,
                [
                  { label: 'Platform', value: attestationData.checks.cpu.platform },
                  { label: 'Product', value: attestationData.checks.cpu.product },
                  { label: 'Measurement', value: attestationData.checks.cpu.measurement },
                ],
                attestationData.links ? { url: attestationData.links.cpuQuote, text: 'View raw attestation quote' } : undefined
              )}
              {renderAttestItem(
                'workload',
                'Verified Workload',
                attestationData.checks.workload.passed
                  ? 'The software running inside this TEE matches the expected, publicly auditable configuration. No unauthorized code modifications detected.'
                  : 'Workload verification failed. The software running inside the TEE could not be confirmed to match the expected configuration.',
                attestationData.checks.workload.passed,
                [
                  { label: 'Status', value: attestationData.checks.workload.status },
                  { label: 'Template', value: attestationData.checks.workload.templateName },
                ],
                attestationData.links ? { url: attestationData.links.dockerCompose, text: 'View docker-compose' } : undefined
              )}
              {renderAttestItem(
                'tls',
                'TLS Binding',
                attestationData.checks.tlsBinding.passed
                  ? 'The TLS certificate presented by this server is cryptographically bound to the CPU attestation quote. This ensures you are communicating directly with the attested TEE, with no middleman.'
                  : 'TLS binding could not be verified. The connection to this server may not be bound to the attested environment.',
                attestationData.checks.tlsBinding.passed,
                [
                  { label: 'TLS Fingerprint', value: attestationData.checks.tlsBinding.fingerprint },
                ]
              )}
              {renderAttestItem(
                'gpu',
                'GPU Attestation',
                attestationData.checks.gpu.passed
                  ? "The NVIDIA GPU has been verified through NVIDIA's Remote Attestation Service. Secure boot is active and all firmware measurements are valid. Verified GPU and CPU attestation binding through report_data."
                  : "GPU attestation could not be verified. The GPU's integrity could not be confirmed through NVIDIA's Remote Attestation Service.",
                attestationData.checks.gpu.passed,
                [
                  { label: 'GPU Model', value: attestationData.checks.gpu.model },
                  { label: 'Secure Boot', value: attestationData.checks.gpu.secureBoot === true ? 'Enabled' : attestationData.checks.gpu.secureBoot === false ? 'Disabled' : null },
                  { label: 'CPU Binding', value: attestationData.checks.gpu.cpuBound === true ? 'Verified' : attestationData.checks.gpu.cpuBound === false ? 'Failed' : null },
                ],
                attestationData.links ? { url: attestationData.links.gpuAttestation, text: 'View GPU attestation report' } : undefined
              )}
              {renderAttestItem(
                'poc',
                'Proof of Cloud',
                attestationData.checks.proofOfCloud.passed
                  ? "The machine's identity has been validated against a known cloud provider. This confirms the server is running on legitimate infrastructure, not a simulated environment."
                  : "Proof of Cloud could not be validated. The machine's cloud provider identity could not be confirmed.",
                attestationData.checks.proofOfCloud.passed,
                []
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AttestationPanel;
