import {
  AI_SENDER,
  DEFAULT_SYSTEM_PROMPT,
  OPEN_AI_API_URL, USER_SENDER,
} from '@/constants';
import { ChatMessage } from '@/sharedState';
import { Notice, requestUrl } from 'obsidian';
import { SSE } from 'sse';

export type Role = 'assistant' | 'user' | 'system';

export interface OpenAiMessage {
  role: Role;
  content: string;
}

export interface OpenAiParams {
  model: string,
  key: string,
  temperature: number,
  maxTokens: number,
}

export class OpenAIRequestManager {
  stopRequested = false;

  constructor() {}

  stopStreaming() {
    this.stopRequested = true;
  }

  streamSSE = async (
    openAiParams: OpenAiParams,
    messages: OpenAiMessage[],
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    systemPrompt: string,
  ) => {
    return new Promise((resolve, reject) => {
      try {
        const {
          key,
          model,
          temperature,
          maxTokens,
        } = openAiParams;

        const formattedMessages = [
          {
            role: 'system',
            content: systemPrompt,
          },
          ...messages,
        ];

        const url = OPEN_AI_API_URL;
        const options = {
          model,
          messages: formattedMessages,
          max_tokens: maxTokens,
          temperature: temperature,
          stream: true,
        };

        const source = new SSE(url, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key ? key : process.env.OPENAI_API_KEY}`,
            ...(process.env.OPENAI_ORGANIZATION && {
              'OpenAI-Organization': process.env.OPENAI_ORGANIZATION,
            }),
          },
          method: 'POST',
          payload: JSON.stringify(options),
        });

        let aiResponse = '';

        const addAiMessageToChatHistory = (aiResponse: string) => {
          const botMessage: ChatMessage = {
              message: aiResponse,
              sender: AI_SENDER,
              isVisible: true,
            };
          addMessage(botMessage);
          updateCurrentAiMessage('');
        }

        const onMessage = async (e: any) => {
          if (this.stopRequested) {
            console.log('Manually closing SSE stream due to stop request.');
            source.close();
            addAiMessageToChatHistory(aiResponse);
            this.stopRequested = false;
            resolve(null);
            return;
          }

          if (e.data !== "[DONE]") {
            const payload = JSON.parse(e.data);
            const text = payload.choices[0].delta.content;
            if (!text) {
              return;
            }
            aiResponse += text;
            updateCurrentAiMessage(aiResponse);
          } else {
            source.close();
            addAiMessageToChatHistory(aiResponse);
            resolve(aiResponse);
          }
        };

        source.addEventListener('message', onMessage);

        source.addEventListener('error', (e: any) => {
          source.close();
          reject(e);
        });

        source.stream();
      } catch (err) {
        reject(err);
      }
    });
  };
}

export const OpenAIRequest = async (
  model: string,
  key: string,
  messages: OpenAiMessage[],
  temperature: number,
  maxTokens: number,
  systemPrompt: string,
): Promise<string> => {
  const formattedMessages: OpenAiMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
    ...messages,
  ];
  const res = await requestUrl({
    url: OPEN_AI_API_URL,
    headers: {
      'Content-Type': 'application/json',
      'HTTP-Referer': `https://github.com/logancyang/obsidian-copilot`, // To identify your app. Can be set to e.g. http://localhost:3000 for testing
      'X-Title': `Obsidian CoPilot`, // Optional. Shows on openrouter.ai

      Authorization: `Bearer ${key ? key : process.env.OPENAI_API_KEY}`,
      ...(process.env.OPENAI_ORGANIZATION && {
        'OpenAI-Organization': process.env.OPENAI_ORGANIZATION,
      }),
    },
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      temperature: temperature,
      stream: false,
    }),
  });

  if (res.status !== 200) {
    throw new Error(`OpenAI API returned an error: ${res.status}`);
  }

  return res.json.choices[0].message.content;
};

export const getAIResponse = async (
  userMessage: ChatMessage,
  chatContext: ChatMessage[],
  openAiParams: OpenAiParams,
  streamManager: OpenAIRequestManager,
  updateCurrentAiMessage: (message: string) => void,
  addMessage: (message: ChatMessage) => void,
  stream = true,
  debug = false,
  userSystemPrompt?: string,
) => {
  const {
    key,
    model,
    temperature,
    maxTokens,
  } = openAiParams;

  const messages: OpenAiMessage[] = [
    ...chatContext.map((chatMessage) => {
      return {
        role: chatMessage.sender === USER_SENDER
          ? 'user' as Role : 'assistant' as Role,
        content: chatMessage.message,
      };
    }),
    { role: 'user', content: userMessage.message },
  ];

  const systemPrompt = userSystemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (debug) {
    console.log('openAiParams:', openAiParams);
    console.log('stream:', stream);
    console.log('system prompt:', systemPrompt);
    for (const [i, message] of messages.entries()) {
      console.log(`Message ${i}:\nrole: ${message.role}\n${message.content}`);
    }
  }

  if (stream) {
    // Use streamManager.streamSSE to send message to AI and get a response
    try {
      await streamManager.streamSSE(
        openAiParams,
        messages,
        updateCurrentAiMessage,
        addMessage,
        systemPrompt,
      );
    } catch (error) {
      const errorData = JSON.parse(error.data);
      if (errorData && errorData.error) {
        new Notice(
          `OpenAI error: ${errorData.error.code}. `
          + `Pls check the console for the full error message.`
        );
      }
      console.error('Error in streamSSE:', error.data);
    }
  } else {
    // Non-streaming setup using OpenAIRequest
    try {
      const aiResponse = await OpenAIRequest(
        model,
        key,
        messages,
        temperature,
        maxTokens,
        systemPrompt,
      );

      const botMessage: ChatMessage = {
        message: aiResponse,
        sender: AI_SENDER,
        isVisible: true,
      };
      addMessage(botMessage);
      updateCurrentAiMessage('');

    } catch (error) {
      new Notice(`OpenAI non-streaming error: ${error.status}`);
      console.error(error);
    }
  }
};
