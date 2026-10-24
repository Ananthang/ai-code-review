import { HttpProvider, HttpProviderOptions } from './http.js';

export class OpenAIProvider extends HttpProvider {
  constructor(options: HttpProviderOptions) { super('openai', options); }
}
