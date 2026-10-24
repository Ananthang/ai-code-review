import { HttpProvider, HttpProviderOptions } from './http.js';

export class GeminiProvider extends HttpProvider {
  constructor(options: HttpProviderOptions) { super('gemini', options); }
}
