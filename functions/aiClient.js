/**
 * Azure OpenAI chat completion for the file chat. Same resource and key as the option-chain
 * features (aiAnalysisPrompt.js analyzeWithAI stays the JSON-only helper for those). `content` of a
 * message may be an array of parts, which is how files are sent: {type:'file', file:{filename,
 * file_data:'data:application/pdf;base64,...'}} for a PDF, {type:'text', text} for text.
 */

import axios from 'axios'

/** Config from process.env (local server); Cloud Functions bind the secrets as env vars. */
export function getChatConfigFromEnv(env = process.env) {
  return {
    apiKey: env.AZURE_OPENAI_API_KEY,
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    deployment: env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: env.AZURE_OPENAI_API_VERSION || '2024-10-21',
  }
}

/** One chat completion -> { message, usage, finishReason }. Throws "Chat request failed (status): reason". */
export async function chatCompletion(messages, config, { temperature = 0.2, maxTokens = 1500, timeout = 120000 } = {}, { http = axios } = {}) {
  if (!config?.apiKey || !config?.endpoint || !config?.deployment) throw new Error('Chat config incomplete: need apiKey, endpoint and deployment')
  const url = `${config.endpoint.replace(/\/+$/, '')}/openai/deployments/${config.deployment}/chat/completions?api-version=${config.apiVersion || '2024-10-21'}`
  let response
  try {
    response = await http.post(url, { messages, temperature, max_tokens: maxTokens }, { headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json' }, timeout, maxBodyLength: Infinity, maxContentLength: Infinity })
  } catch (error) {
    const status = error.response?.status
    throw new Error(`Chat request failed${status ? ` (${status})` : ''}: ${error.response?.data?.error?.message || error.message}`)
  }
  const choice = response.data.choices?.[0]
  if (!choice) throw new Error('Chat response had no choices')
  return { message: choice.message, usage: response.data.usage ?? null, finishReason: choice.finish_reason }
}
