const crypto = require('crypto');

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateJobId() {
  const now = new Date();
  const iso = now.toISOString();
  const ts = iso.replace(/[-:]/g, '').split('.')[0] + 'Z';

  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += ALPHANUM[crypto.randomInt(ALPHANUM.length)];
  }

  return `${ts}-${rand}`;
}

module.exports = { generateJobId };
