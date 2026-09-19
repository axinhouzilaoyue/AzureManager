// Azure Manager frontend entry (classic scripts; load order matters).
// Prefer loading /js/*.js from index.html. This file remains as a no-op
// compatibility shim for bookmarks that still request /app.js.
console.debug('[azure-manager] app modules are loaded from /js/* via index.html');
