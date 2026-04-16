import OpenAI from 'openai';
import { getEnv } from './env.js';

let client;

export function getOpenAIClient() {
  if (client) return client;
  const { OPENAI_API_KEY } = getEnv();
  client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
}
