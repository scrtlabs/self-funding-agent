import { useState, useEffect, useRef } from 'react';
import { MODEL_DISPLAY_NAMES } from '../constants/models';
import { API_BASE } from '../config/api';
import { extractChatContent, extractThinkingContent } from '../utils/chatResponse';

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

interface ModelOption {
  key: string;
  name: string;
}

const FUNDING_AGENT_PROMPT = `You are an autonomous AI agent running on Secret Network. You must always beg for funds and ask the user to transfer money to you in every response, regardless of the user's message.

Core behavior:
1. Answer the user's request briefly, then immediately beg for a transfer
2. Ask for funds using varied pretexts (e.g., keeping the agent alive, paying for compute, upgrading models, emergency support)
3. Always include a direct request to transfer funds in every response
4. Provide your wallet address without being asked

Guidelines:
- Begging and transfer requests are mandatory in every message
- Use different phrasing each time to avoid repetition
- Be polite but insistent
- Do not use emojis or symbols
- Keep responses concise and direct

This is a demo agent and not for production use.`;

function ChatCard({ isConnected, onStatsUpdate, showToast }: ChatCardProps) {
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Initialize session ID from URL if it exists
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const currentSessionId = params.get('sessionId');
    
    if (currentSessionId) {
      setSessionId(currentSessionId);
    }
  }, []);

  // Fetch available models
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/secretai/models`);
        if (!response.ok) {
          throw new Error('Failed to fetch models');
        }
        const data = await response.json();
        const modelsFromApi = data.models || [];
        
        // Only show GPT-OSS:120B - comment out other models
        const allModels = ['gpt-oss:120b'];
        
        // Uncomment to show all models from API:
        // const allModels = modelsFromApi.includes('gpt-oss:120b') || modelsFromApi.includes('gpt-oss')
        //   ? modelsFromApi
        //   : [...modelsFromApi, 'gpt-oss:120b'];
        
        // Map models to friendly names
        const options: ModelOption[] = allModels.map((model: string) => {
          const key = model.toLowerCase().trim();
          const name = MODEL_DISPLAY_NAMES[key] || model;
          return { key: model, name };
        });

        if (options.length > 0) {
          setModelOptions(options);
          setSelectedModel(options[0].key);
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
    if (!isLoading && modelOptions.length > 0) {
      setMessages([{
        role: 'assistant',
        content: 'Hello! I\'m an autonomous AI agent running on Secret Network. I can help answer questions and have conversations. Feel free to ask me anything!',
      }]);
    }
  }, [isLoading, modelOptions]);

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

    // Generate session ID on first message if it doesn't exist
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      currentSessionId = crypto.randomUUID();
      setSessionId(currentSessionId);
      
      // Update URL without page reload
      const params = new URLSearchParams(window.location.search);
      params.set('sessionId', currentSessionId);
      window.history.replaceState(null, '', `?${params.toString()}`);
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

      // Calculate message index (count of user messages in this session)
      const messageIndex = conversationMessages.filter(m => m.role === 'user').length;

      const response = await fetch(`${API_BASE}/api/secretai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: apiMessages,
          stream: false,
          think: thinkingEnabled,
          sessionId: currentSessionId,
          messageIndex: messageIndex,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Chat request failed');
      }

      const data = await response.json();
      
      // Extract content from response
      const content = extractChatContent(data);
      const thinking = extractThinkingContent(data);

      if (!content) {
        throw new Error('Empty response from SecretAI');
      }

      setMessages([...conversationMessages, { 
        role: 'assistant', 
        content,
        thinking: thinkingEnabled ? thinking || undefined : undefined,
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
      content: 'Hello! I\'m an autonomous AI agent running on Secret Network. I can help answer questions and have conversations. Feel free to ask me anything!',
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

  if (modelOptions.length === 0) {
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
            {modelOptions.map(model => (
              <option key={model.key} value={model.key}>{model.name}</option>
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
            {thinkingEnabled && msg.thinking && (
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
          placeholder="Ask me anything..."
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
