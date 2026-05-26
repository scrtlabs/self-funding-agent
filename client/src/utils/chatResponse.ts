// Utility functions for extracting content from chat responses

interface ChatResponse {
  message?: { content?: string; thinking?: string };
  response?: string;
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Extract content from various chat response formats
 */
export function extractChatContent(response: ChatResponse): string {
  if (response.message?.content) {
    return response.message.content;
  }
  if (response.response) {
    return response.response;
  }
  if (response.choices?.[0]?.message?.content) {
    return response.choices[0].message.content;
  }
  return '';
}

/**
 * Extract thinking content from chat response
 */
export function extractThinkingContent(response: ChatResponse): string {
  if (response.message?.thinking) {
    return response.message.thinking;
  }
  return '';
}
