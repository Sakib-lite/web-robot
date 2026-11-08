export function isGlmRequest(url: string, model: string): boolean {
  return /z\.ai|bigmodel|glm/i.test(url) || /glm/i.test(model);
}
