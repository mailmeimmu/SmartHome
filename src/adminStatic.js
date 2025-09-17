const path = require('path');

function getAdminConsolePath() {
  // If running from repo root, console lives in ../public/admin.
  // In deployment, we expect /var/www/SmartHome/public/admin
  const explicit = process.env.ADMIN_CONSOLE_ROOT;
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const localPath = path.join(__dirname, '..', '..', 'public', 'admin');
  return localPath;
}

module.exports = {
  getAdminConsolePath,
};
