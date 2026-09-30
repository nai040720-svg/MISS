// Test-only egress guard. SillyTavern and mock providers may contact loopback only.
const allowed = value => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value);
for (const scheme of ['http', 'https']) {
 const module = require(scheme);
 for (const method of ['request','get']) {
  const original = module[method];
  module[method] = function(input, ...args) {
   const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname || input.host?.split(':')[0] || 'localhost';
   if (!allowed(host)) throw new Error(`Mock test blocked external request: ${host}`);
   return original.call(this, input, ...args);
  };
 }
}
const originalFetch = global.fetch;
global.fetch = function(input, ...args) {
 const host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname;
 if (!allowed(host)) throw new Error(`Mock test blocked external fetch: ${host}`);
 return originalFetch(input, ...args);
};
