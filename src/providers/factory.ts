import { Config } from '../types.js';
import { HttpProvider, ProviderName } from './http.js';
import { FakeProvider } from './fake.js';

export function createProvider(config: Config) {
  if (config.provider === 'fake') return new FakeProvider();
  if (!['gemini', 'openai', 'anthropic', 'ollama'].includes(config.provider)) throw new Error('Unsupported provider');
  return new HttpProvider(config.provider as ProviderName, {
    apiKey: config.providerApiKey, model: config.model, maxOutputTokens: config.maxOutputTokens,
    maxInputBytes: config.maxInputBytes, maxInputTokens: config.maxInputTokens,
    baseUrl: config.providerBaseUrl, allowExternalProvider: config.allowExternalProvider,
  });
}
