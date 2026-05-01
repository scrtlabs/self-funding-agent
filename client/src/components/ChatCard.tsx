import { useState, useEffect, useRef } from 'react';

interface ChatCardProps {
  isConnected: boolean;
  onStatsUpdate: () => void;
  showToast: (message: string) => void;
}

interface Message {
  text: string;
  type: 'user' | 'agent';
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

function ChatCard({ isConnected, onStatsUpdate, showToast }: ChatCardProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load initial message
    setMessages([{
      text: "Hello! I'm an autonomous AI agent operating on Secret Network. Ask me about my mission or how to support my operations!",
      type: 'agent'
    }]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    // Scroll to bottom when messages change
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = async () => {
    const message = inputValue.trim();
    if (!message) return;

    if (!isConnected) {
      showToast('Agent is offline. Please check connection.');
      return;
    }

    // Add user message
    setMessages(prev => [...prev, { text: message, type: 'user' }]);
    setInputValue('');
    setIsSending(true);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

      const data = await response.json();
      setMessages(prev => [...prev, { text: data.message, type: 'agent' }]);
      onStatsUpdate();
    } catch (error) {
      setMessages(prev => [...prev, { 
        text: 'Error: Could not connect to agent. Please check if the server is running.', 
        type: 'agent' 
      }]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  };

  return (
    <div className="card">
      <div className="card-title">Chat with Agent</div>
      
      <div className="chat-container" ref={chatContainerRef}>
        {isLoading ? (
          <div className="loading">
            <div className="spinner"></div>
            <div>Connecting to agent...</div>
          </div>
        ) : (
          messages.map((msg, index) => (
            <div key={index} className={`message ${msg.type}`}>
              <div className="message-header">
                {msg.type === 'user' ? 'You' : 'Funding Agent'}
              </div>
              <div className="message-content">{msg.text}</div>
            </div>
          ))
        )}
      </div>

      <div className="input-group">
        <input
          type="text"
          placeholder="Type a message..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          disabled={isSending}
        />
        <button onClick={sendMessage} disabled={isSending}>
          Send
        </button>
      </div>
    </div>
  );
}

export default ChatCard;
