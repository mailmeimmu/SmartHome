const path = require('path');

function getAdminConsolePath() {
  // Primary location lives inside server/public/admin.
  // Fallback to repo root public/admin for older checkouts.
  const explicit = process.env.ADMIN_CONSOLE_ROOT;
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const candidates = [
    path.join(__dirname, '..', 'server', 'public', 'admin'),
    path.join(__dirname, '..', 'public', 'admin'),
    path.join(__dirname, '..', '..', 'public', 'admin'),
  ];
  for (const candidate of candidates) {
    try {
      require('fs').accessSync(candidate);
      return candidate;
    } catch {}
  }
  return candidates[0];
}

module.exports = {
  getAdminConsolePath,
};
