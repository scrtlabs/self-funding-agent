interface ToastProps {
  message: string;
  show: boolean;
}

function Toast({ message, show }: ToastProps) {
  return (
    <div className={`toast ${show ? 'show' : ''}`} style={{
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      background: 'rgba(0, 0, 0, 0.9)',
      backdropFilter: 'blur(20px)',
      color: 'white',
      padding: '16px 24px',
      borderRadius: '12px',
      boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
      display: show ? 'block' : 'none',
      animation: show ? 'slideUp 0.3s ease' : 'none',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      zIndex: 1000,
    }}>
      {message}
    </div>
  );
}

export default Toast;
