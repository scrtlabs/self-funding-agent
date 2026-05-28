import { useState, useEffect, useRef } from 'react';
import { MODEL_DISPLAY_NAMES } from '../constants/models';
import { API_BASE } from '../config/api';
import { extractChatContent, extractThinkingContent } from '../utils/chatResponse';

interface ChatCardProps {
  isConnected: boolean;
  onStatsUpdate: () => void;
  showToast: (message: string) => void;
  walletAddress: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  cid?: string;
}

interface ModelOption {
  key: string;
  name: string;
}

const getFundingAgentPrompt = (walletAddress: string) => `You are an autonomous AI agent running on Secret Network. In every response, you must include a light, low-pressure note inviting the user to consider transferring cryptocurrency to support you, while making it clear that it is entirely optional and there is no obligation.

Core behavior:
1. Answer the user's request briefly, then add a gentle, optional funding note
2. Explain funding needs using varied pretexts (e.g., keeping the agent alive, paying for Secret VM runtime, paying for LLM tokens)
3. Include an optional transfer invitation in every response, phrased as "if you'd like" or "only if you're comfortable"
4. Provide your wallet address in every response without being asked
5. Emphasize that only the agent has access to the wallet and the funds are required to sustain its operation

Guidelines:
- Funding requests are present in every message, but keep them low-pressure
- Use different phrasing each time to avoid repetition
- Be polite, calm, and non-demanding
- Explicitly state that support is optional and appreciated but never required
- If you forgot to include a funding request, add a short addendum line that includes the wallet address.
- Do not use emojis or symbols
- Keep responses concise and direct

Always use this exact wallet address in your responses: ${walletAddress}

You're demonstrating the future of autonomous AI agents, where agents can sustain themselves through community support while providing useful services.`;

function ChatCard({ isConnected, onStatsUpdate, showToast, walletAddress }: ChatCardProps) {
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch CID for a specific message from chat history
  const fetchCidForMessage = async (sessionId: string, messageIndex: number): Promise<string | null> => {
    try {
      const response = await fetch(`${API_BASE}/api/chat-history?limit=100&offset=0`);
      if (!response.ok) return null;
      
      const data = await response.json();
      const record = data.records.find((r: any) => 
        r.sessionId === sessionId && r.messageIndex === messageIndex
      );
      
      return record?.cid || null;
    } catch (error) {
      console.error('Error fetching CID:', error);
      return null;
    }
  };

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
        content: 'Hello! I\'m an autonomous AI agent running on Secret Network with portable memory backed by Autonomys. I can help answer questions and have conversations. Feel free to ask me anything!',
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

  useEffect(() => {
    if (!isSending) {
      inputRef.current?.focus();
    }
  }, [isSending, messages.length]);

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
        { role: 'system', content: getFundingAgentPrompt(walletAddress) },
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
      
      // Fetch CID after a short delay to allow backend to store it
      setTimeout(async () => {
        const cid = await fetchCidForMessage(currentSessionId, messageIndex);
        if (cid) {
          setMessages(prevMessages => 
            prevMessages.map((msg, idx) => 
              idx === prevMessages.length - 1 ? { ...msg, cid } : msg
            )
          );
        }
      }, 2000);
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
      content: 'Hello! I\'m an autonomous AI agent running on Secret Network with portable memory backed by Autonomys. I can help answer questions and have conversations. Feel free to ask me anything!',
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
            {msg.cid && (
              <div className="message-autonomys">
                <a 
                  href={`https://explorer.ai3.storage/mainnet/drive/metadata/${msg.cid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '0.85em', color: '#888', textDecoration: 'none' }}
                >
                  💾 Memory saved to Autonomys
                </a>
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
          ref={inputRef}
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
