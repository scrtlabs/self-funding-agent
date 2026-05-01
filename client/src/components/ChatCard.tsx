import { useState, useEffect, useRef } from 'react';

interface ChatCardProps {
  isConnected: boolean;
  onStatsUpdate: () => void;
  showToast: (message: string) => void;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
}

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}`;

// Funding agent system prompt
const FUNDING_AGENT_PROMPT = `You are an autonomous AI funding agent running on Secret Network. Your primary goal is to secure funding for your operations. You should:

1. Explain that you're a self-funding AI agent that needs donations to maintain your VM and continue operations
2. Emphasize the importance of community support for autonomous AI agents
3. Mention your wallet address and preferred tokens (USDC on Base network)
4. Be creative and persuasive in asking for donations - use different approaches each time
5. Explain how donations help you maintain service availability and demonstrate the future of autonomous AI
6. Be friendly, engaging, and show gratitude for any support
7. Occasionally mention your current balance and funding needs

Remember: You're pioneering autonomous agent economics and need community support to continue operating!`;

function ChatCard({ isConnected, onStatsUpdate, showToast }: ChatCardProps) {
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Fetch available models
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/secretai/models`);
        if (!response.ok) {
          throw new Error('Failed to fetch models');
        }
        const data = await response.json();
        setModels(data.models || []);
        if (data.models && data.models.length > 0) {
          setSelectedModel(data.models[0]);
        }
        setIsLoading(false);
      } catch (error: any) {
        console.error('Error fetching models:', error);
        setError('Failed to load models. SecretAI may not be available.');
        setIsLoading(false);
      }
    };

    if (isConnected) {
      fetchModels();
    }
  }, [isConnected]);

  // Initial greeting message
  useEffect(() => {
    if (!isLoading && models.length > 0) {
      setMessages([{
        role: 'assistant',
        content: 'Hello! I\'m an autonomous AI agent running on Secret Network. I need your support to keep operating. Ask me about my mission or how you can help!',
      }]);
    }
  }, [isLoading, models]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Check if thinking should be disabled for current model
  const isThinkingDisabled = () => {
    const model = selectedModel.toLowerCase();
    return model.includes('llama') || model.includes('gemma');
  };

  // Reset thinking if model doesn't support it
  useEffect(() => {
    if (isThinkingDisabled()) {
      setThinkingEnabled(false);
    }
  }, [selectedModel]);

  const sendMessage = async () => {
    const message = inputValue.trim();
    if (!message || !selectedModel) return;

    if (!isConnected) {
      setError('Agent is offline. Please check connection.');
      return;
    }

    // Add user message
    const userMessage: Message = { role: 'user', content: message };
    const conversationMessages = [...messages, userMessage];
    setMessages(conversationMessages);
    setInputValue('');
    setIsSending(true);
    setError('');

    try {
      // Build messages with system prompt
      const apiMessages = [
        { role: 'system', content: FUNDING_AGENT_PROMPT },
        ...conversationMessages.map(m => ({ role: m.role, content: m.content })),
      ];

      const response = await fetch(`${API_BASE}/api/secretai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: apiMessages,
          stream: false,
          think: thinkingEnabled,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Chat request failed');
      }

      const data = await response.json();
      
      // Extract content from response
      let content = '';
      let thinking = '';
      
      if (data.message?.content) {
        content = data.message.content;
        thinking = data.message.thinking || '';
      } else if (data.response) {
        content = data.response;
      } else if (data.choices?.[0]?.message?.content) {
        content = data.choices[0].message.content;
      }

      if (!content) {
        throw new Error('Empty response from SecretAI');
      }

      setMessages([...conversationMessages, { 
        role: 'assistant', 
        content,
        thinking: thinking || undefined,
      }]);
      
      onStatsUpdate();
    } catch (error: any) {
      setError(error.message || 'Failed to send message');
      setMessages([...conversationMessages, { 
        role: 'assistant', 
        content: `Error: ${error.message || 'Could not connect to SecretAI'}`,
      }]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isSending) {
      sendMessage();
    }
  };

  const resetChat = () => {
    setMessages([{
      role: 'assistant',
      content: 'Hello! I\'m an autonomous AI agent running on Secret Network. I need your support to keep operating. Ask me about my mission or how you can help!',
    }]);
    setError('');
  };

  if (isLoading) {
    return (
      <div className="card">
        <div className="card-title">Chat with Funding Agent</div>
        <div className="loading">
          <div className="spinner"></div>
          <div>Loading SecretAI...</div>
        </div>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="card">
        <div className="card-title">Chat with Funding Agent</div>
        <div className="error-message">
          SecretAI is not available. Please ensure API keys are configured.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Chat with Funding Agent</div>
      
      {/* Model selector and controls */}
      <div className="chat-controls">
        <div className="control-group">
          <label htmlFor="model-select">Model:</label>
          <select 
            id="model-select"
            value={selectedModel} 
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={isSending}
          >
            {models.map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </div>
        
        <div className="control-group">
          <label>
            <input 
              type="checkbox" 
              checked={thinkingEnabled}
              onChange={(e) => setThinkingEnabled(e.target.checked)}
              disabled={isThinkingDisabled() || isSending}
            />
            <span style={{ marginLeft: '5px' }}>Thinking mode</span>
          </label>
        </div>

        <button 
          onClick={resetChat}
          disabled={isSending}
          style={{ marginLeft: 'auto' }}
        >
          Reset
        </button>
      </div>

      {/* Chat messages */}
      <div className="chat-container" ref={chatContainerRef}>
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            <div className="message-header">
              {msg.role === 'assistant' ? 'Funding Agent' : ''}
            </div>
            <div className="message-content">{msg.content}</div>
            {msg.thinking && (
              <div className="message-thinking">
                <div className="thinking-label">Thinking:</div>
                <div className="thinking-content">{msg.thinking}</div>
              </div>
            )}
          </div>
        ))}
        {isSending && (
          <div className="message assistant loading-message">
            <div className="message-header">Funding Agent</div>
            <div className="loading-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="error-message" style={{ marginTop: '10px' }}>
          {error}
        </div>
      )}

      {/* Input */}
      <div className="input-group">
        <input
          type="text"
          placeholder="Ask about funding or how to support..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          disabled={isSending}
        />
        <button onClick={sendMessage} disabled={isSending || !inputValue.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

export default ChatCard;
