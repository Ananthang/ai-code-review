import { HttpProvider, HttpProviderOptions } from './http.js';

export class AnthropicProvider extends HttpProvider {
  constructor(options: HttpProviderOptions) { super('anthropic', options); }
}
