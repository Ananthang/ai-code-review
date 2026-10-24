import { HttpProvider, HttpProviderOptions } from './http.js';

export class OllamaProvider extends HttpProvider {
  constructor(options: HttpProviderOptions) { super('ollama', options); }
}
